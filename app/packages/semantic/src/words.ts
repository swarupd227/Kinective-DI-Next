// An institution's own words (Core Mapping and Ontology, phase 11): what's in force, the ledger of
// changes, and the questions DI couldn't read. Words are added and removed only through an approved
// change; each is a new row in onto_word, and the latest row for a word decides.
import type { Pool } from '@dinext/tenant-db';
import type { InstitutionWord } from '@dinext/ontology';

const rows = async <T>(pool: Pool, sql: string, params: unknown[] = []) => (await pool.query(sql, params))[0] as T[];
const norm = (s: string) => s.toLowerCase().replace(/[’']/g, '').replace(/[^a-z0-9&]+/g, ' ').trim();

export interface WordChange {
  term: string;
  concept: string | null;
  action: 'add' | 'remove';
  at: string;
  byName: string;
  approvalId: string;
  question: string | null;
}

export interface UnreadQuestion {
  question: string;
  times: number;
  last: string;
}

export class WordStore {
  constructor(private readonly pool: Pool) {}

  /** Every change, oldest first. Empty where the table isn't there yet (a tenant seeded before phase 11). */
  async history(): Promise<WordChange[]> {
    const found = await rows<{ term: string; concept_id: string | null; action: string; at: unknown; by_name: string; approval_id: string; question: string | null }>(
      this.pool,
      'SELECT term, concept_id, action, at, by_name, approval_id, question FROM onto_word ORDER BY word_id',
    ).catch(() => []);
    return found.map((r) => ({ term: r.term, concept: r.concept_id, action: r.action === 'remove' ? 'remove' : 'add', at: (r.at instanceof Date ? r.at.toISOString() : String(r.at)).slice(0, 10), byName: r.by_name, approvalId: r.approval_id, question: r.question }));
  }

  /** The words in force: the latest change for each word, when it adds one. */
  async current(): Promise<(InstitutionWord & { at: string; byName: string })[]> {
    const latest = new Map<string, WordChange>();
    for (const c of await this.history()) latest.set(norm(c.term), c);
    return [...latest.values()].filter((c) => c.action === 'add' && c.concept).map((c) => ({ term: c.term, concept: c.concept!, at: c.at, byName: c.byName }));
  }

  async add(w: { term: string; concept: string; byUser: string; byName: string; approvalId: string; question?: string }) {
    await this.pool.query('INSERT INTO onto_word (term, concept_id, action, at, by_user, by_name, approval_id, question) VALUES (?, ?, ?, NOW(3), ?, ?, ?, ?)', [norm(w.term), w.concept, 'add', w.byUser, w.byName.slice(0, 80), w.approvalId, w.question?.slice(0, 500) ?? null]);
  }

  async remove(w: { term: string; byUser: string; byName: string; approvalId: string }) {
    await this.pool.query('INSERT INTO onto_word (term, concept_id, action, at, by_user, by_name, approval_id, question) VALUES (?, NULL, ?, NOW(3), ?, ?, ?, NULL)', [norm(w.term), 'remove', w.byUser, w.byName.slice(0, 80), w.approvalId]);
  }

  /**
   * Questions Analytics Q&A couldn't map to a defined measure in the last `days`, most asked first. The
   * text is as the audit ledger keeps it, after identifiers were masked.
   */
  async unread(days = 180, limit = 50): Promise<UnreadQuestion[]> {
    const found = await rows<{ question: string; n: number; last: unknown }>(
      this.pool,
      `SELECT question, COUNT(*) AS n, MAX(at) AS last FROM ai_run WHERE outcome = 'unmatched' AND at >= (SELECT MAX(at) FROM ai_run) - INTERVAL ? DAY GROUP BY question ORDER BY n DESC, last DESC LIMIT ${Math.min(Math.max(limit, 1), 200)}`,
      [days],
    ).catch(() => []);
    return found.map((r) => ({ question: r.question, times: Number(r.n), last: (r.last instanceof Date ? r.last.toISOString() : String(r.last)).slice(0, 10) }));
  }
}
