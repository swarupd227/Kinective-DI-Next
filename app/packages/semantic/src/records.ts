// The records behind a number: the loans, accounts or members a metric counts, under the same filters
// and purview, with the condition taken from the governed measure itself ("delinquent" is whatever the
// measure says it is). Read-only, largest first, capped, and members are named only for people whose
// access includes member details.
import type { Pool } from '@dinext/tenant-db';
import { setting, type CompileEnv } from './compile.ts';
import { SemanticError } from './request.ts';

export type RecordKind = 'loans' | 'accounts' | 'members';

const KIND: Record<string, RecordKind> = { loan_current: 'loans', deposit_current: 'accounts', party_current: 'members' };

/** What each kind lists, beside the member and branch. */
const COLUMNS: Record<RecordKind, { select: string; join: string; balance: string | null }> = {
  loans: { select: 'l.loan_id AS id, l.loan_category AS category, l.balance AS balance, l.rate AS rate, l.days_delinquent AS days_past_due, l.open_date AS opened, l.credit_score AS credit_score, l.ltv AS ltv, l.term_months AS term_months, l.risk_rating AS risk_rating', join: 'JOIN cdm_party AS pm ON pm.party_id = l.party_id', balance: 'l.balance' },
  accounts: { select: 'd.account_id AS id, d.deposit_category AS category, d.balance AS balance, d.rate AS rate, d.maturity_date AS matures, d.open_date AS opened', join: 'JOIN cdm_party AS pm ON pm.party_id = d.party_id', balance: 'd.balance' },
  members: { select: 'p.party_id AS id, p.segment_code AS category, p.join_date AS opened', join: 'JOIN cdm_party AS pm ON pm.party_id = p.party_id', balance: null },
};

export interface RecordsResult {
  metric: string;
  label: string;
  kind: RecordKind;
  /** Plain-language filters applied, including the measure's own condition. */
  conditions: string[];
  count: number;
  total: number | null;
  rows: Record<string, string | number | null>[];
  limit: number;
}

/** The CASE WHEN condition of a conditional SUM, e.g. "l.days_delinquent >= 60". */
const conditionOf = (expr: string) => /CASE WHEN (.+?) THEN/i.exec(expr)?.[1] ?? null;

export function recordKindFor(env: CompileEnv, metric: string): RecordKind | null {
  const m = env.model.metrics[metric];
  if (!m) return null;
  const measure = env.model.measures[m.measures[0]!];
  if (!measure) return null;
  const source = Object.keys(KIND).find((s) => measure.exprs[s]);
  return source ? KIND[source]! : null;
}

export async function listRecords(pool: Pool, env: CompileEnv, req: { metric: string; filters?: { dimension: string; values: string[] }[]; limit?: number }, ctx: { purviewBranches?: string[]; memberDetails?: boolean }): Promise<RecordsResult> {
  const { model } = env;
  const m = model.metrics[req.metric];
  if (!m) throw new SemanticError('UNKNOWN_METRIC', `There is no metric called "${req.metric}".`, Object.keys(model.metrics));
  const measureName = m.measures[0]!;
  const measure = model.measures[measureName]!;
  const sourceName = Object.keys(KIND).find((s) => measure.exprs[s]);
  if (!sourceName) throw new SemanticError('NO_SOURCE', `${m.label} isn’t counted from individual loans, accounts or members, so there are no records to list.`);
  const source = model.sources[sourceName]!;
  const kind = KIND[sourceName]!;
  const cols = COLUMNS[kind];
  const where = [...source.filters];
  const params: (string | number)[] = [];
  const conditions: string[] = [];
  const cond = conditionOf(setting(measure.exprs[sourceName]!, model));
  if (cond) {
    where.push(`(${cond})`);
    conditions.push(m.label);
  }
  for (const f of req.filters ?? []) {
    const dim = model.dimensions[f.dimension];
    const expr = dim?.exprs[sourceName];
    if (!dim || !expr) throw new SemanticError('DIMENSION_NOT_ALLOWED', `${m.label} records can’t be filtered by ${dim?.label.toLowerCase() ?? f.dimension}.`);
    const options = env.dimensionValues[f.dimension] ?? [];
    const values = f.values.map((v) => options.find((o) => o.toLowerCase() === v.trim().toLowerCase()) ?? v);
    where.push(`${expr} IN (${values.map(() => '?').join(', ')})`);
    params.push(...values);
    conditions.push(`${dim.label} is ${values.join(', ')}`);
  }
  if (ctx.purviewBranches) {
    const outside = (req.filters ?? []).filter((f) => f.dimension === 'branch').flatMap((f) => f.values).filter((v) => !ctx.purviewBranches!.some((b) => b.toLowerCase() === v.toLowerCase()));
    if (outside.length) throw new SemanticError('NO_ACCESS', `${outside.join(', ')} ${outside.length === 1 ? 'is' : 'are'} outside the branches you can see.`);
    const ids = ctx.purviewBranches.map((b) => env.branchIds[b]).filter((x): x is number => x !== undefined);
    where.push(`${source.purview_column} IN (${ids.length ? ids.map(() => '?').join(', ') : 'NULL'})`);
    params.push(...ids);
  }
  const from = `FROM ${source.table} AS ${source.alias} ${source.joins.join(' ')} ${cols.join} WHERE ${where.join(' AND ')}`;
  const limit = Math.min(Math.max(req.limit ?? 50, 1), 200);
  const [agg] = (await pool.query(`SELECT COUNT(*) AS n${cols.balance ? `, SUM(${cols.balance}) AS total` : ''} ${from}`, params)) as unknown as [{ n: number; total?: number }[]];
  const [found] = (await pool.query(`SELECT ${cols.select}, pm.party_id AS member_id, pm.first_name, pm.last_name, loc.name AS branch ${from} ORDER BY ${cols.balance ?? `${source.alias}.join_date DESC`}${cols.balance ? ' DESC' : ''} LIMIT ${limit}`, params)) as unknown as [Record<string, unknown>[]];
  const day = (v: unknown) => (v ? String(v instanceof Date ? v.toISOString() : v).slice(0, 10) : null);
  const rows = found.map((r) => {
    const member = ctx.memberDetails ? `${r.first_name} ${r.last_name} (…${String(r.member_id).padStart(4, '0').slice(-4)})` : `Member …${String(r.member_id).padStart(4, '0').slice(-4)}`;
    const base: Record<string, string | number | null> = { id: Number(r.id), member, branch: String(r.branch), category: String(r.category ?? '') };
    if (kind === 'loans') return { ...base, balance: Number(r.balance), rate: Number(r.rate), days_past_due: Number(r.days_past_due), opened: day(r.opened), credit: r.credit_score !== null && r.credit_score !== undefined ? String(r.credit_score) : r.risk_rating ? `Rated ${r.risk_rating}` : '', ltv: r.ltv !== null && r.ltv !== undefined ? `${Math.round(Number(r.ltv))}%` : '', term: r.term_months ? `${r.term_months} mo` : 'Revolving' };
    if (kind === 'accounts') return { ...base, balance: Number(r.balance), rate: Number(r.rate), matures: day(r.matures), opened: day(r.opened) };
    return { ...base, opened: day(r.opened) };
  });
  return { metric: req.metric, label: m.label, kind, conditions, count: Number(agg[0]?.n ?? 0), total: cols.balance ? Number(agg[0]?.total ?? 0) : null, rows, limit };
}
