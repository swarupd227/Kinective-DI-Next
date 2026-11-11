// Predictive Analytics beyond the single member: which products the next-best-product model suggests
// across the book, by the person's deposit balance (DI's "Products to Suggest"), the people behind any
// one count, and whether earlier suggestions were taken up (DI's "Successful Suggestions"). Everything
// is limited to the user's purview. A suggestion a person declined is left out while it is suppressed.
import type { Pool } from '@dinext/tenant-db';
import { CoreError, type CoreContext } from './referrals.ts';

/** Deposit balance bands, as DI's Products to Suggest report splits them. */
export const BALANCE_BANDS = ['$10,000+', '$1,000 to $9,999', '$100 to $999', '$0 to $99', 'Below $0'] as const;
export type BalanceBand = (typeof BALANCE_BANDS)[number];
/** A suggestion scored 6 or more is the model's "high-scoring" suggestion, the same cut the 360 shows. */
export const HIGH_LIKELIHOOD = 6;
/** Score bands for how well the score predicts a sale. */
export const LIKELIHOOD_BANDS = [
  { label: '8 to 10', min: 8, max: 10 },
  { label: '6 to 7', min: 6, max: 7 },
  { label: 'Below 6', min: 0, max: 5 },
] as const;

const BAND_SQL = `CASE WHEN COALESCE(d.bal, 0) >= 10000 THEN '$10,000+' WHEN COALESCE(d.bal, 0) >= 1000 THEN '$1,000 to $9,999' WHEN COALESCE(d.bal, 0) >= 100 THEN '$100 to $999' WHEN COALESCE(d.bal, 0) >= 0 THEN '$0 to $99' ELSE 'Below $0' END`;
const BALANCES = '(SELECT party_id, SUM(balance) AS bal FROM cdm_deposit_account WHERE close_date IS NULL GROUP BY party_id)';

export interface SuggestionCell { product: string; band: BalanceBand; count: number }
export interface SuggestedPerson { partyId: number; name: string; last4: string; branch: string; likelihood: number; balance: number; reason: string }
export interface SuccessRow { label: string; suggested: number; opened: number; ratePct: number }

const num = (v: unknown) => Number(v ?? 0);
const last4 = (partyId: number) => String(10_004_520 + partyId).slice(-4);

export class PredictiveService {
  constructor(private readonly pool: Pool) {}

  private scope(ctx: CoreContext) {
    return ctx.purviewBranches ? { sql: ' AND b.name IN (?)', params: [ctx.purviewBranches.length ? ctx.purviewBranches : ['']] } : { sql: '', params: [] as unknown[] };
  }

  /** The products the model suggests, scored 6 or more, by deposit balance band. */
  async suggestions(ctx: CoreContext, minLikelihood = HIGH_LIKELIHOOD) {
    const s = this.scope(ctx);
    const [rows] = await this.pool.query(
      `SELECT x.product, ${BAND_SQL} AS band, COUNT(*) AS n, MAX(x.run_date) AS run, MAX(x.model_version) AS model
         FROM cdm_suggestion x JOIN cdm_party p ON p.party_id = x.party_id JOIN cdm_location b ON b.int_id = p.primary_branch_id LEFT JOIN ${BALANCES} d ON d.party_id = x.party_id
        WHERE x.likelihood >= ? AND NOT EXISTS (SELECT 1 FROM mod_suggestion_decline m WHERE m.suggestion_id = x.suggestion_id AND m.reversed_at IS NULL AND m.suppressed_until >= CURDATE())${s.sql}
        GROUP BY x.product, band`,
      [minLikelihood, ...s.params],
    );
    const list = rows as { product: string; band: BalanceBand; n: number; run: unknown; model: string }[];
    if (!list.length) throw new CoreError('NOT_FOUND', 'The next-best-product model has no suggestions here yet.');
    const cells: SuggestionCell[] = list.map((r) => ({ product: r.product, band: r.band, count: num(r.n) }));
    const products = [...new Set(cells.map((c) => c.product))]
      .map((product) => ({ product, total: cells.filter((c) => c.product === product).reduce((t, c) => t + c.count, 0), byBand: Object.fromEntries(BALANCE_BANDS.map((b) => [b, cells.find((c) => c.product === product && c.band === b)?.count ?? 0])) as Record<BalanceBand, number> }))
      .sort((a, b) => b.total - a.total);
    const run = list[0]!.run;
    return { minLikelihood, run: run instanceof Date ? run.toISOString().slice(0, 10) : String(run).slice(0, 10), model: list[0]!.model, products, total: cells.reduce((t, c) => t + c.count, 0) };
  }

  /** The people behind one count: a product, optionally one balance band, highest score first. */
  async people(product: string, band: BalanceBand | null, ctx: CoreContext, limit = 200, minLikelihood = HIGH_LIKELIHOOD) {
    const s = this.scope(ctx);
    const [rows] = await this.pool.query(
      `SELECT x.party_id, p.first_name, p.last_name, b.name AS branch, x.likelihood, COALESCE(d.bal, 0) AS bal, x.reason, ${BAND_SQL} AS band
         FROM cdm_suggestion x JOIN cdm_party p ON p.party_id = x.party_id JOIN cdm_location b ON b.int_id = p.primary_branch_id LEFT JOIN ${BALANCES} d ON d.party_id = x.party_id
        WHERE x.product = ? AND x.likelihood >= ? AND NOT EXISTS (SELECT 1 FROM mod_suggestion_decline m WHERE m.suggestion_id = x.suggestion_id AND m.reversed_at IS NULL AND m.suppressed_until >= CURDATE())${s.sql}
        ${band ? 'HAVING band = ?' : ''} ORDER BY x.likelihood DESC, bal DESC, x.party_id`,
      [product, minLikelihood, ...s.params, ...(band ? [band] : [])],
    );
    const all = (rows as { party_id: number; first_name: string; last_name: string; branch: string; likelihood: number; bal: unknown; reason: string }[]).map((r) => ({ partyId: r.party_id, name: `${r.first_name} ${r.last_name}`, last4: last4(r.party_id), branch: r.branch, likelihood: r.likelihood, balance: num(r.bal), reason: r.reason }) satisfies SuggestedPerson);
    return { product, band, total: all.length, items: all.slice(0, limit) };
  }

  /** Whether earlier suggestions were taken up: by product, by monthly run, and by score band. */
  async successes(ctx: CoreContext) {
    const s = this.scope(ctx);
    const from = `FROM cdm_suggestion_history h JOIN cdm_party p ON p.party_id = h.party_id JOIN cdm_location b ON b.int_id = p.primary_branch_id WHERE 1 = 1${s.sql}`;
    const q = async (group: string) => {
      const [rows] = await this.pool.query(`SELECT ${group} AS k, COUNT(*) AS n, SUM(h.opened_date IS NOT NULL) AS opened ${from} GROUP BY k ORDER BY k`, s.params);
      return (rows as { k: unknown; n: number; opened: number }[]).map((r) => ({ k: r.k, suggested: num(r.n), opened: num(r.opened) }));
    };
    const row = (label: string, suggested: number, opened: number): SuccessRow => ({ label, suggested, opened, ratePct: suggested ? (opened / suggested) * 100 : 0 });
    const [byProduct, byRun, byScore] = await Promise.all([q('h.product'), q('h.run_date'), q('h.likelihood')]);
    if (!byRun.length) throw new CoreError('NOT_FOUND', 'No earlier suggestion runs are on file, so DI can’t tell which suggestions were taken up yet.');
    const total = byRun.reduce((t, r) => ({ suggested: t.suggested + r.suggested, opened: t.opened + r.opened }), { suggested: 0, opened: 0 });
    const day = (v: unknown) => (v instanceof Date ? v.toISOString().slice(0, 10) : String(v).slice(0, 10));
    return {
      runs: byRun.map((r) => row(day(r.k), r.suggested, r.opened)),
      products: byProduct.map((r) => row(String(r.k), r.suggested, r.opened)).sort((a, b) => b.opened - a.opened),
      scores: LIKELIHOOD_BANDS.map((band) => {
        const inBand = byScore.filter((r) => num(r.k) >= band.min && num(r.k) <= band.max);
        return row(band.label, inBand.reduce((t, r) => t + r.suggested, 0), inBand.reduce((t, r) => t + r.opened, 0));
      }),
      total: row('All suggestions', total.suggested, total.opened),
    };
  }
}
