// People from the ontology (Core Mapping and Ontology, phase 7): who has a say over an account, in the
// roles DI's ontology defines, and whether a person on an application is someone the institution
// already knows, scored on the identity properties the ontology weights. Read only.
import { ontology } from '@dinext/ontology';
import type { Pool } from '@dinext/tenant-db';
import { CoreError } from './referrals.ts';

type InstitutionType = 'credit_union' | 'bank';
const rows = async <T>(pool: Pool, sql: string, params: unknown[] = []) => (await pool.query(sql, params))[0] as T[];
const day = (v: unknown) => (v instanceof Date ? v.toISOString().slice(0, 10) : v ? String(v).slice(0, 10) : null);

// ---- roles on an account -------------------------------------------------------------------------

export interface AccountParty {
  partyId: number;
  name: string;
  /** The role in the ontology's words, and what it lets the person do. */
  role: string;
  roleId: string;
  means: string;
  /** Inside the person asking's branches; a person outside is counted, not named. */
  visible: boolean;
}

export interface AccountRoles {
  kind: 'deposit' | 'loan';
  accountId: number;
  product: string;
  parties: AccountParty[];
  /** The membership's representative payee flag, from the core: there's a payee, though DI holds no payee record. */
  repPayee: boolean;
  /** The household the primary owner belongs to, with its head. */
  household: { name: string | null; head: string | null; members: number } | null;
}

/** The ontology's role for a value DI holds ("Joint", "Rep payee"), with its label and meaning. */
export function roleOf(value: string) {
  const vs = ontology().valueSets.get('role_on_account');
  for (const [id, c] of Object.entries(vs?.codes ?? {})) if (c.values.some((v) => v.toLowerCase() === value.toLowerCase())) return { id, label: c.label, means: c.definition ?? '' };
  return { id: 'other', label: value, means: '' };
}

// ---- matching people -----------------------------------------------------------------------------

export interface Identity {
  first: string;
  last: string;
  birth?: string | null;
  email?: string | null;
  phone?: string | null;
  street?: string | null;
  zip?: string | null;
  ssnLast4?: string | null;
}

type Field = keyof Identity;
/** Which ontology property each identity field is: its weight and how it compares come from there. */
const FIELD_PROPERTY: Record<Field, string> = { first: 'member.first_name', last: 'member.last_name', birth: 'member.birth_date', email: 'member.email', phone: 'member.phone', street: 'member.street', zip: 'member.zip', ssnLast4: 'member.ssn_last4' };
const FIELD_WORD: Record<Field, string> = { first: 'first name', last: 'last name', birth: 'birth date', email: 'email', phone: 'phone', street: 'street', zip: 'ZIP code', ssnLast4: 'last four of the tax ID' };

/** Same person at or above this score; a possible match, for a person to confirm, at or above the next. */
export const SAME_PERSON = 0.85;
export const POSSIBLE_MATCH = 0.6;

export interface MatchResult {
  partyId: number | null;
  name: string | null;
  score: number;
  decision: 'same person' | 'possible match' | 'new';
  /** The fields that agreed, in words; a familiar first name says so. */
  agreed: string[];
  runnerUp: { partyId: number; score: number } | null;
}

const text = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();

/** How alike two values of a field are, from 0 to 1, by the comparison the ontology gives the field. */
function likeness(how: string, field: Field, a: string, b: string, nick: Map<string, Set<string>>): number {
  if (how === 'date' || how === 'exact') return a.trim().toLowerCase() === b.trim().toLowerCase() ? 1 : 0;
  if (how === 'digits') {
    const d = (s: string) => s.replace(/\D/g, '').slice(-10);
    return d(a).length >= 7 && d(a) === d(b) ? 1 : 0;
  }
  if (how === 'name') {
    const x = text(a);
    const y = text(b);
    if (x === y) return 1;
    // A familiar form of a first name is nearly as good: Bob for Robert.
    if (field === 'first' && nick.get(x)?.has(y)) return 0.8;
    return 0;
  }
  return text(a) === text(b) ? 1 : 0;
}

interface Known extends Identity {
  partyId: number;
}

/**
 * Scores a person against one record: the weighted share of the person's own identity fields that
 * agree. Fields the person didn't give don't count either way; a field the record lacks counts as not
 * agreeing, so a name alone never reaches a match.
 */
export function scoreIdentity(person: Identity, known: Identity) {
  const o = ontology();
  let total = 0;
  let got = 0;
  const agreed: string[] = [];
  for (const f of Object.keys(FIELD_PROPERTY) as Field[]) {
    const mine = person[f];
    if (!mine) continue;
    const m = o.properties.get(FIELD_PROPERTY[f])?.match;
    if (!m) continue;
    total += m.weight;
    const theirs = known[f];
    if (!theirs) continue;
    const l = likeness(m.how, f, String(mine), String(theirs), o.nicknames);
    got += m.weight * l;
    if (l > 0) agreed.push(l < 1 ? `familiar ${FIELD_WORD[f]}` : FIELD_WORD[f]);
  }
  return { score: total ? Math.round((got / total) * 100) / 100 : 0, agreed };
}

export class PeopleService {
  private known: { list: Known[]; byLast: Map<string, Known[]>; byBirth: Map<string, Known[]> } | null = null;

  constructor(
    private readonly pool: Pool,
    private readonly type: InstitutionType,
  ) {}

  /** Everyone with a role on an account, by the account's number or its last four digits. */
  async onAccount(ref: string, purviewBranches?: string[], kind?: 'deposit' | 'loan'): Promise<AccountRoles> {
    const digits = ref.replace(/\D/g, '');
    if (!digits) throw new CoreError('INVALID', 'Give the account number, or its last four digits.');
    // Four digits may be the end of a longer number; anything else is the whole number. Share and loan
    // numbers are separate series, so the same number can be one of each.
    const found = await rows<{ kind: 'deposit' | 'loan'; id: number; product: string; party_id: number }>(
      this.pool,
      `SELECT * FROM (SELECT 'deposit' AS kind, account_id AS id, deposit_category AS product, party_id FROM cdm_deposit_account WHERE account_id = ? OR (? AND account_id % 10000 = ?)
       UNION ALL SELECT 'loan', loan_id, loan_category, party_id FROM cdm_loan WHERE loan_id = ? OR (? AND loan_id % 10000 = ?)) x WHERE ? IS NULL OR x.kind = ? LIMIT 6`,
      [Number(digits), digits.length === 4, Number(digits), Number(digits), digits.length === 4, Number(digits), kind ?? null, kind ?? null],
    );
    const exact = found.filter((f) => String(f.id) === digits);
    const pick = exact.length ? exact : found;
    const what = kind === 'loan' ? 'loan' : kind === 'deposit' ? 'share or deposit account' : 'share, deposit or loan account';
    if (!pick.length) throw new CoreError('NOT_FOUND', `No ${what} ${digits.length === 4 ? 'ends in' : 'is numbered'} ${digits}.`);
    if (pick.length > 1 && new Set(pick.map((p) => p.kind)).size > 1 && pick.length === 2) throw new CoreError('INVALID', `${digits} is both a share account and a loan. Say which: “share account ${digits}” or “loan ${digits}”.`);
    if (pick.length > 1) throw new CoreError('INVALID', `${pick.length > 5 ? 'Several' : pick.length} accounts end in ${digits}. Give the whole account number.`);
    const acct = pick[0]!;
    const owners = await rows<{ party_id: number; role: string; first_name: string; last_name: string; branch: string | null }>(
      this.pool,
      `SELECT o.party_id, o.role, p.first_name, p.last_name, b.name AS branch FROM cdm_account_owner o JOIN cdm_party p ON p.party_id = o.party_id
       LEFT JOIN cdm_location b ON b.int_id = p.primary_branch_id WHERE o.account_kind = ? AND o.account_id = ? ORDER BY o.role = 'Primary' DESC, o.role, p.last_name`,
      [acct.kind, acct.id],
    );
    const see = (branch: string | null) => !purviewBranches || (branch !== null && purviewBranches.includes(branch));
    const parties = owners.map((r) => {
      const role = roleOf(r.role);
      return { partyId: r.party_id, name: `${r.first_name} ${r.last_name}`, role: role.label, roleId: role.id, means: role.means, visible: see(r.branch) };
    });
    const [m] = await rows<{ is_rep_payee: number | null }>(this.pool, 'SELECT is_rep_payee FROM cdm_account WHERE primary_party_id = ? LIMIT 1', [acct.party_id]).catch(() => []);
    const [h] = await rows<{ name: string | null; head: string | null; members: number }>(
      this.pool,
      `SELECT h.name, CONCAT(hp.first_name, ' ', hp.last_name) AS head, (SELECT COUNT(*) FROM cdm_party x WHERE x.household_id = p.household_id) AS members
       FROM cdm_party p LEFT JOIN cdm_household h ON h.household_id = p.household_id LEFT JOIN cdm_party hp ON hp.party_id = h.head_party_id WHERE p.party_id = ? AND p.household_id IS NOT NULL`,
      [acct.party_id],
    ).catch(() => []);
    return { kind: acct.kind, accountId: acct.id, product: acct.product, parties, repPayee: Number(m?.is_rep_payee ?? 0) === 1, household: h ? { name: h.name, head: h.head, members: Number(h.members) } : null };
  }

  private async load() {
    if (this.known) return this.known;
    const list = await rows<{ party_id: number; first_name: string; last_name: string; birth_date: unknown; email: string | null; phone: string | null; street: string | null; zip: string | null; ssn_last4: string | null }>(
      this.pool,
      `SELECT p.party_id, p.first_name, p.last_name, p.birth_date, c.email, c.phone, a.street, a.zip, d.ssn_last4 FROM cdm_party p
       LEFT JOIN cdm_party_contact c ON c.party_id = p.party_id LEFT JOIN cdm_party_address a ON a.party_id = p.party_id LEFT JOIN cdm_party_detail d ON d.party_id = p.party_id`,
    );
    const known = list.map((r): Known => ({ partyId: r.party_id, first: r.first_name, last: r.last_name, birth: day(r.birth_date), email: r.email, phone: r.phone, street: r.street, zip: r.zip, ssnLast4: r.ssn_last4 }));
    const byLast = new Map<string, Known[]>();
    const byBirth = new Map<string, Known[]>();
    for (const k of known) {
      (byLast.get(text(k.last)) ?? byLast.set(text(k.last), []).get(text(k.last))!).push(k);
      if (k.birth) (byBirth.get(k.birth) ?? byBirth.set(k.birth, []).get(k.birth)!).push(k);
    }
    return (this.known = { list: known, byLast, byBirth });
  }

  /** The record a person most likely is, scored on the ontology's identity properties. */
  async match(person: Identity): Promise<MatchResult> {
    const k = await this.load();
    // Only records that share the last name or the birth date can score well enough to matter.
    const pool = new Map<number, Known>();
    for (const c of [...(k.byLast.get(text(person.last)) ?? []), ...(person.birth ? (k.byBirth.get(person.birth) ?? []) : [])]) pool.set(c.partyId, c);
    const scored = [...pool.values()].map((c) => ({ c, ...scoreIdentity(person, c) })).sort((a, b) => b.score - a.score || a.c.partyId - b.c.partyId);
    const best = scored[0];
    const second = scored[1];
    if (!best || best.score < POSSIBLE_MATCH) return { partyId: null, name: null, score: best?.score ?? 0, decision: 'new', agreed: best?.agreed ?? [], runnerUp: null };
    // Two records nearly as good are for a person to choose between, however high the score.
    const close = second && best.score - second.score < 0.05;
    const decision = best.score >= SAME_PERSON && !close ? 'same person' : 'possible match';
    return { partyId: best.c.partyId, name: `${best.c.first} ${best.c.last}`, score: best.score, decision, agreed: best.agreed, runnerUp: second ? { partyId: second.c.partyId, score: second.score } : null };
  }

  /**
   * Every membership applicant matched against the people DI holds, and how DI's decisions compare with
   * the person each application is recorded against (the application's own link, set when it was
   * booked or when the core already knew the applicant).
   */
  async matchApplicants() {
    const list = await rows<{ applicant_id: number; first_name: string; last_name: string; birth_date: unknown; email: string | null; street: string | null; base_zip: string | null; party_id: number | null; planted: number }>(
      this.pool,
      `SELECT a.applicant_id, a.first_name, a.last_name, a.birth_date, a.email, a.street, a.base_zip, a.party_id,
         EXISTS (SELECT 1 FROM cdm_person_match m WHERE m.source_table = 'cdm_membership_applicant' AND m.source_id = a.applicant_id AND m.party_id IS NOT NULL) AS planted
       FROM cdm_membership_applicant a ORDER BY a.applicant_id`,
    );
    const out: { applicantId: number; name: string; recorded: number | null; existing: boolean; result: MatchResult }[] = [];
    for (const a of list) {
      const result = await this.match({ first: a.first_name, last: a.last_name, birth: day(a.birth_date), email: a.email, street: a.street, zip: a.base_zip });
      out.push({ applicantId: a.applicant_id, name: `${a.first_name} ${a.last_name}`, recorded: a.party_id, existing: Number(a.planted) === 1, result });
    }
    const tally = (group: typeof out) => ({
      applicants: group.length,
      linked: group.filter((x) => x.recorded !== null).length,
      same: group.filter((x) => x.result.decision === 'same person').length,
      sameRight: group.filter((x) => x.result.decision === 'same person' && x.result.partyId === x.recorded).length,
      possible: group.filter((x) => x.result.decision === 'possible match').length,
      possibleRight: group.filter((x) => x.result.decision === 'possible match' && x.result.partyId === x.recorded).length,
      missed: group.filter((x) => x.recorded !== null && x.result.decision === 'new').length,
      wrong: group.filter((x) => x.result.decision !== 'new' && x.result.partyId !== x.recorded).length,
    });
    return { all: tally(out), existing: tally(out.filter((x) => x.existing)), booked: tally(out.filter((x) => !x.existing && x.recorded !== null)), unlinked: tally(out.filter((x) => x.recorded === null)), rows: out };
  }
}
