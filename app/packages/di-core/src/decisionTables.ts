// Decision tables (DMN): rules people read and change, which DI applies to its own data. The engine reads
// DMN's cells: "-" for any value, comparisons (< 640, >= 50000), ranges ([640..700) includes 640, not
// 700), lists (High, Medium), not(...) and yes/no; and its hit policies: FIRST (the first rule that
// matches decides), UNIQUE (only one may match), RULE ORDER (every match, in order) and COLLECT (every
// match, optionally summed). A change is checked before anyone approves it: every cell must parse, and
// DI runs the old and new tables over the same data to say who or what it would move. The change takes
// effect as a new version once someone other than the person asking approves it; every version is kept.
import type { Pool } from '@dinext/tenant-db';
import type { DmnColumn, DmnRule, DmnTableDef } from '@dinext/tenant-db';
import { CoreError } from './referrals.ts';

const rows = async <T>(pool: Pool, sql: string, params: unknown[] = []) => (await pool.query(sql, params))[0] as T[];
const nowSql = () => new Date().toISOString().slice(0, 19).replace('T', ' ');
const num = (s: string) => Number(s.replace(/[$,%\s]/g, ''));

export type CellValue = string | number | boolean | null;
type Test = (v: CellValue) => boolean;

/** One condition cell as a test, or an error saying what's wrong with it. */
export function parseCell(cell: string, col: DmnColumn): Test {
  const c = String(cell ?? '').trim();
  if (c === '' || c === '-') return () => true;
  const neg = /^not\s*\((.*)\)$/i.exec(c);
  if (neg) {
    const inner = parseCell(neg[1]!, col);
    return (v) => !inner(v);
  }
  if (col.type === 'boolean') {
    if (/^(yes|true|y)$/i.test(c)) return (v) => v === true || /^(yes|true|1)$/i.test(String(v));
    if (/^(no|false|n)$/i.test(c)) return (v) => v === false || v === null || /^(no|false|0)$/i.test(String(v));
    throw new CoreError('INVALID', `“${c}” isn’t yes or no, for ${col.label}.`);
  }
  if (col.type === 'number') {
    const range = /^([[\]()])\s*(-?[\d,.$%]+)\s*\.\.\s*(-?[\d,.$%]+)\s*([[\]()])$/.exec(c);
    if (range) {
      const lo = num(range[2]!);
      const hi = num(range[3]!);
      const loIn = range[1] === '[';
      const hiIn = range[4] === ']';
      if (Number.isNaN(lo) || Number.isNaN(hi) || lo > hi) throw new CoreError('INVALID', `“${c}” isn’t a range, for ${col.label}: write it like [640..700).`);
      return (v) => v !== null && v !== '' && !Number.isNaN(Number(v)) && (loIn ? Number(v) >= lo : Number(v) > lo) && (hiIn ? Number(v) <= hi : Number(v) < hi);
    }
    const cmp = /^(<=|>=|<|>|=)?\s*(-?[\d,.$%]+)$/.exec(c);
    if (cmp) {
      const x = num(cmp[2]!);
      if (Number.isNaN(x)) throw new CoreError('INVALID', `“${c}” isn’t a number, for ${col.label}.`);
      const op = cmp[1] ?? '=';
      return (v) => {
        if (v === null || v === '' || Number.isNaN(Number(v))) return false;
        const n = Number(v);
        return op === '<' ? n < x : op === '<=' ? n <= x : op === '>' ? n > x : op === '>=' ? n >= x : n === x;
      };
    }
    const list = c.split(',').map((x) => num(x));
    if (list.length > 1 && list.every((x) => !Number.isNaN(x))) return (v) => list.includes(Number(v));
    throw new CoreError('INVALID', `“${c}” isn’t a condition DI reads, for ${col.label}: use a number, < 640, >= 50000, [640..700) or -.`);
  }
  const options = c.split(',').map((x) => x.trim().replace(/^"(.*)"$/, '$1').toLowerCase()).filter(Boolean);
  return (v) => v !== null && options.includes(String(v).toLowerCase());
}

/** Every cell of a table, checked: what's wrong, by rule and column. */
export function validateTable(t: Pick<DmnTableDef, 'inputs' | 'outputs' | 'rules' | 'hitPolicy' | 'aggregation'>) {
  const problems: string[] = [];
  t.rules.forEach((r, i) => {
    for (const col of t.inputs) {
      try {
        parseCell(r.when[col.key] ?? '-', col);
      } catch (e) {
        problems.push(`Rule ${i + 1}: ${(e as Error).message}`);
      }
    }
    for (const col of t.outputs) {
      const v = r.then[col.key];
      if (v === undefined || v === '') problems.push(`Rule ${i + 1}: ${col.label} is empty.`);
      else if (col.type === 'number' && Number.isNaN(num(v))) problems.push(`Rule ${i + 1}: ${col.label} “${v}” isn’t a number.`);
      else if (col.values && !col.values.includes(v)) problems.push(`Rule ${i + 1}: ${col.label} must be one of ${col.values.join(', ')}.`);
    }
  });
  if (!t.rules.length) problems.push('The table has no rules.');
  if (t.aggregation && !t.outputs.some((o) => o.type === 'number')) problems.push('A summed table needs a number output.');
  return problems;
}

export interface Decision {
  /** The rules that matched, numbered from 1. */
  matched: number[];
  /** FIRST and UNIQUE: the one rule's outputs. COLLECT and RULE ORDER: every match's. */
  outputs: Record<string, string>[];
  /** A summed table's total, of its first number output. */
  total: number | null;
  /** UNIQUE with more than one match. */
  conflict: boolean;
}

export function compileTable(t: Pick<DmnTableDef, 'inputs' | 'outputs' | 'rules' | 'hitPolicy' | 'aggregation'>) {
  const tests = t.rules.map((r) => t.inputs.map((col) => ({ col, test: parseCell(r.when[col.key] ?? '-', col) })));
  const sumCol = t.outputs.find((o) => o.type === 'number');
  return (values: Record<string, CellValue>): Decision => {
    const matched: number[] = [];
    for (let i = 0; i < tests.length; i++) {
      if (tests[i]!.every(({ col, test }) => test(values[col.key] ?? null))) {
        matched.push(i + 1);
        if (t.hitPolicy === 'FIRST') break;
      }
    }
    const outputs = matched.map((m) => t.rules[m - 1]!.then);
    const total = t.aggregation === 'SUM' && sumCol ? outputs.reduce((s, o) => s + num(o[sumCol.key] ?? '0'), 0) : t.aggregation === 'COUNT' ? outputs.length : null;
    return { matched, outputs: t.hitPolicy === 'FIRST' || t.hitPolicy === 'UNIQUE' ? outputs.slice(0, 1) : outputs, total, conflict: t.hitPolicy === 'UNIQUE' && matched.length > 1 };
  };
}

export interface DecisionTable extends DmnTableDef {
  version: number;
  status: 'Active' | 'Retired';
  note: string | null;
  changedBy: string;
  changedAt: string;
  approvedBy: string | null;
  activatedAt: string | null;
}

export interface TableEdit {
  /** The rule to change or remove, numbered from 1; leave out to add a rule. */
  rule?: number;
  /** Cells to set, by column key or label. */
  set?: Record<string, string>;
  remove?: boolean;
  /** Where a new rule goes, numbered from 1; the end when left out. */
  position?: number;
  note?: string;
}

/** A row of data the table decides on, with how to name it. */
interface Case {
  id: string;
  label: string;
  branch: string;
  values: Record<string, CellValue>;
  extra: Record<string, number | string>;
}

export const TABLE_RESULT_KEY: Record<string, string> = { retention_action: 'action', loan_pricing: 'adjustment' };
/** A summed pricing adjustment over this needs a pricing exception. */
export const PRICING_EXCEPTION_BP = 300;

export class DecisionTableService {
  constructor(
    private readonly pool: Pool,
    private readonly institutionType: 'credit_union' | 'bank' = 'credit_union',
  ) {}

  private parse(r: Record<string, unknown>): DecisionTable {
    const j = <T>(v: unknown) => (typeof v === 'string' ? JSON.parse(v) : v) as T;
    const d = (v: unknown) => (v ? String(v instanceof Date ? v.toISOString() : v).replace(' ', 'T').slice(0, 19) : '');
    return {
      key: String(r.table_key),
      version: Number(r.version),
      status: r.status as DecisionTable['status'],
      name: String(r.name),
      description: String(r.description),
      module: String(r.module),
      hitPolicy: r.hit_policy as DmnTableDef['hitPolicy'],
      ...(r.aggregation ? { aggregation: r.aggregation as DmnTableDef['aggregation'] } : {}),
      inputs: j<DmnColumn[]>(r.inputs),
      outputs: j<DmnColumn[]>(r.outputs),
      rules: j<DmnRule[]>(r.rules),
      note: (r.note as string | null) ?? null,
      changedBy: String(r.changed_by),
      changedAt: d(r.changed_at),
      approvedBy: (r.approved_by as string | null) ?? null,
      activatedAt: r.activated_at ? d(r.activated_at) : null,
    };
  }

  /** The active version of every table, those the person may see. */
  async list(modules?: string[]) {
    const list = (await rows<Record<string, unknown>>(this.pool, "SELECT * FROM dmn_table_version WHERE status = 'Active' ORDER BY table_key")).map((r) => this.parse(r));
    const counts = await rows<{ k: string; n: number }>(this.pool, 'SELECT table_key AS k, COUNT(*) AS n FROM dmn_table_version GROUP BY table_key');
    return list.filter((t) => !modules || modules.includes(t.module)).map((t) => ({ ...t, versions: Number(counts.find((c) => c.k === t.key)?.n ?? 1) }));
  }

  async get(key: string, version?: number) {
    const [r] = await rows<Record<string, unknown>>(this.pool, version ? 'SELECT * FROM dmn_table_version WHERE table_key = ? AND version = ?' : "SELECT * FROM dmn_table_version WHERE table_key = ? AND status = 'Active'", version ? [key, version] : [key]);
    return r ? this.parse(r) : null;
  }

  async history(key: string) {
    return (await rows<Record<string, unknown>>(this.pool, 'SELECT * FROM dmn_table_version WHERE table_key = ? ORDER BY version DESC', [key])).map((r) => this.parse(r));
  }

  /** The data a table decides on today, in purview. */
  private async cases(key: string, purviewBranches?: string[]): Promise<{ cases: Case[]; about: string }> {
    const scope = purviewBranches ? ' AND b.name IN (?)' : '';
    const pv = purviewBranches ? [purviewBranches.length ? purviewBranches : ['']] : [];
    if (key === 'retention_action') {
      const [m] = await rows<{ id: number; month: unknown }>(this.pool, "SELECT m.model_id AS id, (SELECT MAX(month_end) FROM ml_score s WHERE s.model_id = m.model_id) AS month FROM ml_model m WHERE m.name = 'attrition' AND m.status = 'Active'");
      if (!m?.month) throw new CoreError('NOT_FOUND', 'The attrition model hasn’t scored anyone yet, so the retention table has nothing to decide on. DI trains the model when it starts.');
      const list = await rows<Record<string, unknown>>(
        this.pool,
        `SELECT s.party_id, p.first_name, p.last_name, b.name AS branch, s.band, h.deposit_balance, h.products, h.tenure_months, s.month_end
           FROM ml_score s JOIN hist_member_snapshot h ON h.party_id = s.party_id AND h.month_end = s.month_end
           JOIN cdm_party p ON p.party_id = s.party_id JOIN cdm_location b ON b.int_id = p.primary_branch_id
          WHERE s.model_id = ? AND s.month_end = ?${scope}`,
        [m.id, m.month, ...pv],
      );
      if (!list.length) throw new CoreError('NOT_FOUND', 'The attrition model hasn’t scored anyone yet, so the retention table has nothing to decide on. DI trains the model when it starts.');
      const month = String(list[0]!.month_end instanceof Date ? (list[0]!.month_end as Date).toISOString() : list[0]!.month_end).slice(0, 10);
      return {
        about: `the ${list.length.toLocaleString('en-US')} ${this.institutionType === 'bank' ? 'customers' : 'members'} the attrition model scored at the ${month} month-end`,
        cases: list.map((r) => ({ id: String(r.party_id), label: `${r.first_name} ${r.last_name}`, branch: String(r.branch), values: { band: String(r.band), deposits: Number(r.deposit_balance), products: Number(r.products), years: Math.floor(Number(r.tenure_months) / 12) }, extra: { deposits: Number(r.deposit_balance) } })),
      };
    }
    if (key === 'loan_pricing') {
      const list = await rows<Record<string, unknown>>(
        this.pool,
        `SELECT l.loan_id, l.loan_category, l.credit_score, l.ltv, l.term_months, l.rate, l.original_amount, b.name AS branch, (u.direct_deposit_status = 'active') AS dd
           FROM cdm_loan l JOIN cdm_location b ON b.int_id = l.branch_id LEFT JOIN cdm_digital_usage u ON u.party_id = l.party_id
          WHERE l.source IS NULL AND l.loan_category IN ('Auto', 'Personal', 'Consumer') AND l.credit_score IS NOT NULL
            AND l.open_date > DATE_SUB((SELECT MAX(open_date) FROM cdm_loan), INTERVAL 90 DAY)${scope}`,
        pv,
      );
      if (!list.length) throw new CoreError('NOT_FOUND', 'No consumer loans were opened in the last 90 days for the pricing table to decide on.');
      return {
        about: `the ${list.length.toLocaleString('en-US')} consumer loans opened in the last 90 days`,
        cases: list.map((r) => ({ id: String(r.loan_id), label: `${r.loan_category} loan …${String(r.loan_id).slice(-4)}`, branch: String(r.branch), values: { score: Number(r.credit_score), ltv: r.ltv === null ? null : Number(r.ltv), term: r.term_months === null ? null : Number(r.term_months), direct_deposit: Number(r.dd) === 1 }, extra: { amount: Number(r.original_amount), rate: Number(r.rate) } })),
      };
    }
    throw new CoreError('NOT_FOUND', 'DI doesn’t apply that table to its data yet.');
  }

  /** What a table decides for each case today: outcomes, how often each rule fires, and rules that never do. */
  async apply(t: DmnTableDef, purviewBranches?: string[]) {
    const { cases, about } = await this.cases(t.key, purviewBranches);
    const decide = compileTable(t);
    const fired = new Array<number>(t.rules.length).fill(0);
    const decided = cases.map((c) => {
      const d = decide(c.values);
      for (const m of d.matched) fired[m - 1]!++;
      return { c, d, outcome: this.outcome(t, d) };
    });
    const by = new Map<string, number>();
    for (const x of decided) by.set(x.outcome, (by.get(x.outcome) ?? 0) + 1);
    const conflicts = decided.filter((x) => x.d.conflict).length;
    const unmatched = decided.filter((x) => !x.d.matched.length).length;
    return { about, cases: decided.length, decided, outcomes: [...by.entries()].map(([outcome, n]) => ({ outcome, n })).sort((a, b) => b.n - a.n), fired, neverFires: fired.map((n, i) => (n ? 0 : i + 1)).filter(Boolean), conflicts, unmatched };
  }

  /** A case's result in words: the retention action, or the summed pricing adjustment. */
  outcome(t: DmnTableDef, d: Decision) {
    if (!d.matched.length) return 'No rule matches';
    if (d.total !== null) return `${d.total > 0 ? '+' : ''}${d.total} bp`;
    // The main output, with the others after it: "Personal call (Relationship banker, 5 days)".
    const key = TABLE_RESULT_KEY[t.key] ?? t.outputs[0]!.key;
    const rest = t.outputs.filter((o) => o.key !== key);
    return d.outputs.map((o) => `${o[key]}${rest.length && rest.some((c) => o[c.key] && o[c.key] !== '—' && o[c.key] !== '0') ? ` (${rest.map((c) => (/days/i.test(c.label) ? `${o[c.key]} days` : o[c.key])).join(', ')})` : ''}`).join(' + ');
  }

  /** Applies edits to a table: the new rules, what's wrong with them, and who or what they'd move. */
  async propose(key: string, edits: TableEdit[], purviewBranches?: string[]) {
    const cur = await this.get(key);
    if (!cur) throw new CoreError('NOT_FOUND', 'There’s no decision table by that name.');
    const cols = [...cur.inputs.map((c) => ({ ...c, side: 'when' as const })), ...cur.outputs.map((c) => ({ ...c, side: 'then' as const }))];
    const colOf = (name: string) => {
      const n = name.toLowerCase().replace(/\s*\(.*\)\s*$/, '').trim();
      return cols.find((c) => c.key.toLowerCase() === n || c.label.toLowerCase().replace(/\s*\(.*\)\s*$/, '') === n) ?? cols.find((c) => c.label.toLowerCase().startsWith(n) || n.startsWith(c.label.toLowerCase().replace(/\s*\(.*\)\s*$/, '')));
    };
    const rules: DmnRule[] = cur.rules.map((r) => ({ when: { ...r.when }, then: { ...r.then }, ...(r.note ? { note: r.note } : {}) }));
    const changed: { rule: number; what: string }[] = [];
    // Removals last, from the bottom, so rule numbers in the request stay as the person saw them.
    for (const e of edits.filter((x) => !x.remove)) {
      if (e.rule !== undefined) {
        const r = rules[e.rule - 1];
        if (!r) throw new CoreError('INVALID', `There’s no rule ${e.rule}; the table has ${rules.length}.`);
        for (const [name, value] of Object.entries(e.set ?? {})) {
          const col = colOf(name);
          if (!col) throw new CoreError('INVALID', `The table has no column “${name}”: its columns are ${cols.map((c) => c.label).join(', ')}.`);
          const before = r[col.side][col.key];
          r[col.side][col.key] = String(value).trim();
          changed.push({ rule: e.rule, what: `${col.label}: ${before ?? '-'} → ${String(value).trim()}` });
        }
        if (e.note !== undefined) r.note = e.note;
      } else {
        const r: DmnRule = { when: Object.fromEntries(cur.inputs.map((c) => [c.key, '-'])), then: Object.fromEntries(cur.outputs.map((c) => [c.key, ''])), ...(e.note ? { note: e.note } : {}) };
        for (const [name, value] of Object.entries(e.set ?? {})) {
          const col = colOf(name);
          if (!col) throw new CoreError('INVALID', `The table has no column “${name}”: its columns are ${cols.map((c) => c.label).join(', ')}.`);
          r[col.side][col.key] = String(value).trim();
        }
        const at = Math.max(0, Math.min(rules.length, (e.position ?? rules.length + 1) - 1));
        rules.splice(at, 0, r);
        changed.push({ rule: at + 1, what: `New rule: ${cur.inputs.map((c) => `${c.label} ${r.when[c.key]}`).join(', ')} → ${cur.outputs.map((c) => r.then[c.key]).join(', ')}` });
      }
    }
    for (const e of edits.filter((x) => x.remove).sort((a, b) => (b.rule ?? 0) - (a.rule ?? 0))) {
      if (!e.rule || !rules[e.rule - 1]) throw new CoreError('INVALID', `There’s no rule ${e.rule ?? ''} to remove.`);
      rules.splice(e.rule - 1, 1);
      changed.push({ rule: e.rule, what: 'Removed' });
    }
    if (!changed.length) throw new CoreError('INVALID', 'That doesn’t change anything in the table.');
    const next: DmnTableDef = { key: cur.key, name: cur.name, description: cur.description, module: cur.module, hitPolicy: cur.hitPolicy, ...(cur.aggregation ? { aggregation: cur.aggregation } : {}), inputs: cur.inputs, outputs: cur.outputs, rules };
    const problems = validateTable(next);
    const impact = problems.length ? null : await this.compare(cur, next, purviewBranches);
    return { current: cur, next, changed, problems, impact };
  }

  /** The old and new tables over the same data: what moves, from what to what. */
  async compare(a: DmnTableDef, b: DmnTableDef, purviewBranches?: string[]) {
    const before = await this.apply(a, purviewBranches);
    const after = await this.apply(b, purviewBranches);
    const moves = new Map<string, number>();
    let moved = 0;
    const examples: { label: string; branch: string; from: string; to: string }[] = [];
    before.decided.forEach((x, i) => {
      const y = after.decided[i]!;
      if (x.outcome !== y.outcome) {
        moved++;
        const k = `${x.outcome}→${y.outcome}`;
        moves.set(k, (moves.get(k) ?? 0) + 1);
        if (examples.length < 10) examples.push({ label: x.c.label, branch: x.c.branch, from: x.outcome, to: y.outcome });
      }
    });
    const exceptions = (r: typeof before) => r.decided.filter((x) => (x.d.total ?? 0) > PRICING_EXCEPTION_BP).length;
    return {
      about: before.about,
      cases: before.cases,
      moved,
      moves: [...moves.entries()].map(([k, n]) => ({ from: k.split('→')[0]!, to: k.split('→')[1]!, n })).sort((p, q) => q.n - p.n),
      examples,
      before: before.outcomes,
      after: after.outcomes,
      neverFires: after.neverFires,
      conflicts: after.conflicts,
      unmatched: after.unmatched,
      ...(a.key === 'loan_pricing' ? { exceptions: { before: exceptions(before), after: exceptions(after) } } : {}),
    };
  }

  /** Makes a changed table the active version and keeps the one before. */
  async activate(next: DmnTableDef, meta: { requestedBy: string; approvedBy: string; approvalId: string | null; note: string | null; fromVersion: number }) {
    const cur = await this.get(next.key);
    if (!cur) throw new CoreError('NOT_FOUND', 'There’s no decision table by that name.');
    if (cur.version !== meta.fromVersion) throw new CoreError('INVALID', `The table changed since this was prepared: it’s at version ${cur.version} now. Ask again to see the change against it.`);
    const problems = validateTable(next);
    if (problems.length) throw new CoreError('INVALID', problems.join(' '));
    const version = cur.version + 1;
    const at = nowSql();
    await this.pool.query("UPDATE dmn_table_version SET status = 'Retired' WHERE table_key = ? AND status = 'Active'", [next.key]);
    await this.pool.query(
      'INSERT INTO dmn_table_version (table_key, version, status, name, description, module, hit_policy, aggregation, inputs, outputs, rules, note, changed_by, changed_at, approved_by, approval_id, activated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
      [next.key, version, 'Active', next.name, next.description, next.module, next.hitPolicy, next.aggregation ?? null, JSON.stringify(next.inputs), JSON.stringify(next.outputs), JSON.stringify(next.rules), meta.note, meta.requestedBy, at, meta.approvedBy, meta.approvalId, at],
    );
    return { key: next.key, version };
  }
}
