// The Referral Builder Worksheet (DI requirements template, one per referral type): what is referred,
// who creates it, the fields it captures, who receives it, what counts as success and credit, and
// open notes. Fields and routing live on the referral type itself; the rest is the worksheet row.
import type { FormField, Pool, RouteRule, Worksheet } from '@dinext/tenant-db';
import { CoreError, referralTypesChanged } from './referrals.ts';

const rows = async <T>(pool: Pool, sql: string, params: unknown[] = []) => (await pool.query(sql, params))[0] as T[];
const json = <T>(v: unknown) => (typeof v === 'string' ? JSON.parse(v) : v) as T;

export const WORKSHEET_PRODUCTS = ['Checking account', 'Savings account', 'Auto loan', 'Mortgage / HELOC', 'Credit card', 'Business services'];
export const WORKSHEET_CREATORS = ['Tellers', 'Member Service Reps', 'Branch Managers', 'Call Center', 'Loan Officers', 'Online / Digital'];

export interface ReferralTypeSheet {
  typeId: string;
  label: string;
  category: string;
  description: string;
  fields: FormField[];
  route: RouteRule;
  /** "Routed by branch to the branch lending queue, round-robin", in words. */
  receives: string;
  worksheet: Worksheet;
}

export class WorksheetService {
  constructor(private readonly pool: Pool) {}

  private async queueNames() {
    return new Map((await rows<{ queue_id: string; name: string }>(this.pool, 'SELECT queue_id, name FROM esp_com_queues')).map((q) => [q.queue_id, q.name]));
  }

  private receives(route: RouteRule, names: Map<string, string>) {
    if (route.kind === 'queue') return `One shared queue, ${names.get(route.queueId) ?? route.queueId}, whose members claim items`;
    return `Routed by the member’s branch to its ${route.queue === 'lending' ? 'lending' : 'member services'} queue, round-robin; ${names.get(route.fallbackQueue) ?? route.fallbackQueue} if the branch has none`;
  }

  async list(): Promise<ReferralTypeSheet[]> {
    const names = await this.queueNames();
    const found = await rows<Record<string, unknown>>(this.pool, 'SELECT t.type_id, t.label, t.category, t.description, t.route_rule, t.fields, w.products, w.creators, w.success, w.unsuccessful, w.credit, w.credit_rule, w.fallback, w.notes FROM mod_ref_types t LEFT JOIN mod_ref_worksheet w ON w.type_id = t.type_id WHERE t.active = 1 ORDER BY t.category, t.label');
    return found.map((r) => {
      const route = json<RouteRule>(r.route_rule);
      return {
        typeId: r.type_id as string,
        label: r.label as string,
        category: r.category as string,
        description: r.description as string,
        fields: json<FormField[]>(r.fields),
        route,
        receives: this.receives(route, names),
        worksheet: r.products
          ? { products: json(r.products), creators: json(r.creators), success: r.success as string, unsuccessful: r.unsuccessful as string, credit: r.credit as Worksheet['credit'], creditRule: r.credit_rule as string, fallback: r.fallback as string, notes: json(r.notes) }
          : { products: [], creators: [], success: '', unsuccessful: '', credit: 'Not sure yet', creditRule: '', fallback: '', notes: [] },
      };
    });
  }

  /** The referral type a name refers to: "HELOC", "the auto loan referral", "business". */
  async find(name: string) {
    const all = await this.list();
    const words = name.toLowerCase().replace(/\b(the|referral|referrals|type|worksheet|for)\b/g, ' ').split(/\s+/).filter((w) => w.length > 1);
    const hit = all.find((t) => t.label.toLowerCase() === words.join(' ')) ?? all.find((t) => words.length && words.every((w) => `${t.label} ${t.category}`.toLowerCase().includes(w)));
    if (!hit) throw new CoreError('NOT_FOUND', `There’s no referral type called “${name.trim()}”. They are: ${all.map((t) => t.label).join(', ')}.`);
    return hit;
  }

  async queues() {
    return [...(await this.queueNames())].map(([queueId, name]) => ({ queueId, name }));
  }

  /** Changes to sections 1, 2, 5 and 6. Running the same approval again changes nothing. */
  async update(typeId: string, w: Worksheet, meta: { approvalId: string; actor: string; on: string }) {
    await this.pool.query(
      `INSERT INTO mod_ref_worksheet (type_id, products, creators, success, unsuccessful, credit, credit_rule, fallback, notes, updated_by, updated_at, approval_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON DUPLICATE KEY UPDATE products = IF(approval_id <=> VALUES(approval_id), products, VALUES(products)), creators = IF(approval_id <=> VALUES(approval_id), creators, VALUES(creators)), success = IF(approval_id <=> VALUES(approval_id), success, VALUES(success)), unsuccessful = IF(approval_id <=> VALUES(approval_id), unsuccessful, VALUES(unsuccessful)), credit = IF(approval_id <=> VALUES(approval_id), credit, VALUES(credit)), credit_rule = IF(approval_id <=> VALUES(approval_id), credit_rule, VALUES(credit_rule)), fallback = IF(approval_id <=> VALUES(approval_id), fallback, VALUES(fallback)), notes = IF(approval_id <=> VALUES(approval_id), notes, VALUES(notes)), updated_by = VALUES(updated_by), updated_at = VALUES(updated_at), approval_id = VALUES(approval_id)`,
      [typeId, JSON.stringify(w.products), JSON.stringify(w.creators), w.success, w.unsuccessful, w.credit, w.creditRule, w.fallback, JSON.stringify(w.notes), meta.actor, meta.on, meta.approvalId],
    );
  }

  /** A new referral type from a filled-in worksheet: live for creators once approved. Idempotent on the approval. */
  async create(p: { typeId: string; label: string; category: string; description: string; fields: FormField[]; route: RouteRule; worksheet: Worksheet }, meta: { approvalId: string; actor: string; on: string }) {
    const [done] = await rows<{ type_id: string }>(this.pool, 'SELECT type_id FROM mod_ref_worksheet WHERE approval_id = ?', [meta.approvalId]);
    if (done) return;
    const [clash] = await rows<{ type_id: string }>(this.pool, 'SELECT type_id FROM mod_ref_types WHERE type_id = ? OR LOWER(label) = LOWER(?)', [p.typeId, p.label]);
    if (clash) throw new CoreError('INVALID', `A referral type called ${p.label} already exists.`);
    await this.pool.query('INSERT INTO mod_ref_types (type_id, category, label, description, route_rule, fields, active) VALUES (?, ?, ?, ?, ?, ?, 1)', [p.typeId, p.category, p.label, p.description, JSON.stringify(p.route), JSON.stringify(p.fields)]);
    await this.update(p.typeId, p.worksheet, meta);
    referralTypesChanged();
  }
}
