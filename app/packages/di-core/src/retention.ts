// Deposit/Certificate Retention (spec 24.23). What's maturing, who looks likely to leave and what an
// offer would cost are worked out here, never by a model (AI-AGT-230). A rate outside the offer
// rules can't be priced, let alone proposed (AI-AGT-231).
import type { Pool } from '@dinext/tenant-db';
import { CoreError, memberNumber, type CoreContext } from './referrals.ts';
import { attritionBand } from './relationship.ts';

/** The most a renewal may pay by balance [Assumption]: demo rules until a tenant sets its own. */
export const OFFER_RULES = [
  { minBalance: 100_000, rate: 4.75 },
  { minBalance: 50_000, rate: 4.5 },
  { minBalance: 10_000, rate: 4.25 },
  { minBalance: 0, rate: 4 },
];

export const offerRate = (balance: number) => OFFER_RULES.find((r) => balance >= r.minBalance)!.rate;

/** The model's reasons, in words that read in a sentence. */
const SIGNALS: Record<string, string> = { direct_deposit_stopped: 'direct deposit stopped', balance_drop: 'falling balances', single_product: 'only one product', short_tenure: 'a short relationship', no_recent_login: 'no recent login' };
const NO_CHECKING = 'no checking account';

export interface Certificate {
  partyId: number;
  name: string;
  last4: string;
  branch: string;
  amount: number;
  rate: number;
  matures: string;
  daysLeft: number;
  score: number;
  band: 'High' | 'Medium' | 'Low';
  atRisk: boolean;
  signals: string[];
}

export interface RetentionFilter {
  days?: number;
  minAmount?: number;
  atRiskOnly?: boolean;
}

export interface MaturingCertificates {
  asOf: string;
  days: number;
  count: number;
  dollars: number;
  atRisk: { count: number; dollars: number };
  high: number;
  signals: { label: string; count: number }[];
  /** At risk first, then the largest. */
  items: Certificate[];
}

export interface OfferCost {
  asOf: string;
  rate: number;
  count: number;
  dollars: number;
  /** Interest above what they earn now, over one year. */
  cost: number;
  /** Certificates the rules hold below the asked rate, so they're priced at their own limit. */
  held: number;
  /** Already earning at least that much, so they add nothing. */
  noChange: number;
  days: number;
  atRiskOnly: boolean;
}

const day = (v: unknown) => String(v instanceof Date ? v.toISOString() : v).slice(0, 10);
const between = (from: string, to: string) => Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000);

export class RetentionService {
  constructor(private readonly pool: Pool) {}

  private async asOf() {
    const [b] = await this.pool.query("SELECT as_of_date FROM meta_build WHERE state = 'completed' ORDER BY as_of_date DESC LIMIT 1");
    return day((b as { as_of_date: unknown }[])[0]?.as_of_date);
  }

  /** deposit.certificates.maturing, within the user's purview. */
  async maturing(f: RetentionFilter, ctx: CoreContext): Promise<MaturingCertificates> {
    const days = f.days ?? 90;
    const asOf = await this.asOf();
    const scope = ctx.purviewBranches ? ' AND b.name IN (?)' : '';
    const [rows] = await this.pool.query(
      `SELECT d.party_id, d.balance, d.rate, d.maturity_date, p.first_name, p.last_name, b.name AS branch, COALESCE(s.score, 0) AS score, s.factors, c.party_id IS NOT NULL AS has_checking
       FROM cdm_deposit_account d JOIN cdm_party p ON p.party_id = d.party_id JOIN cdm_location b ON b.int_id = d.branch_id LEFT JOIN cdm_attrition_score s ON s.party_id = d.party_id
       LEFT JOIN (SELECT DISTINCT party_id FROM cdm_deposit_account WHERE deposit_category = 'Checking' AND close_date IS NULL) c ON c.party_id = d.party_id
       WHERE d.deposit_category = 'Certificates' AND d.close_date IS NULL AND d.maturity_date BETWEEN ? AND ? + INTERVAL ? DAY AND d.balance >= ?${scope}`,
      [asOf, asOf, days, f.minAmount ?? 0, ...(ctx.purviewBranches ? [ctx.purviewBranches.length ? ctx.purviewBranches : ['']] : [])],
    );
    const all = (rows as Record<string, unknown>[]).map((r): Certificate => {
      const score = Number(r.score);
      const band = attritionBand(score);
      const raw = typeof r.factors === 'string' ? JSON.parse(r.factors) : (r.factors ?? []);
      const factors = (raw as { code: string; weight: number }[]).filter((x) => x.weight > 0 && SIGNALS[x.code]).map((x) => SIGNALS[x.code]!);
      const matures = day(r.maturity_date);
      return { partyId: r.party_id as number, name: `${String(r.first_name)} ${String(r.last_name)}`, last4: memberNumber(r.party_id as number).slice(-4), branch: r.branch as string, amount: Number(r.balance), rate: Number(r.rate), matures, daysLeft: between(asOf, matures), score, band, atRisk: band !== 'Low', signals: [...factors, ...(r.has_checking ? [] : [NO_CHECKING])] };
    });
    const risky = all.filter((c) => c.atRisk);
    const shown = f.atRiskOnly ? risky : all;
    const counts = new Map<string, number>();
    for (const c of risky) for (const s of c.signals) counts.set(s, (counts.get(s) ?? 0) + 1);
    const sum = (list: Certificate[]) => Math.round(list.reduce((n, c) => n + c.amount, 0) * 100) / 100;
    return {
      asOf,
      days,
      count: shown.length,
      dollars: sum(shown),
      atRisk: { count: risky.length, dollars: sum(risky) },
      high: risky.filter((c) => c.band === 'High').length,
      signals: [...counts].map(([label, count]) => ({ label, count })).sort((a, b) => b.count - a.count).slice(0, 3),
      items: [...shown].sort((a, b) => Number(b.atRisk) - Number(a.atRisk) || b.score - a.score || b.amount - a.amount),
    };
  }

  /** deposit.offer_cost.calculate: one year of extra interest, with each renewal held to its rule. */
  async offerCost(rate: number, f: RetentionFilter, ctx: CoreContext): Promise<OfferCost> {
    const top = Math.max(...OFFER_RULES.map((r) => r.rate));
    if (rate > top) throw new CoreError('INVALID', `The offer rules stop at ${top}%, so I can’t price or propose ${rate}%.`);
    const found = await this.maturing(f, ctx);
    let cost = 0;
    let held = 0;
    let noChange = 0;
    for (const c of found.items) {
      const offer = Math.min(rate, offerRate(c.amount));
      if (offer < rate) held += 1;
      if (offer <= c.rate) noChange += 1;
      else cost += (c.amount * (offer - c.rate)) / 100;
    }
    return { asOf: found.asOf, rate, count: found.count, dollars: found.dollars, cost: Math.round(cost * 100) / 100, held, noChange, days: found.days, atRiskOnly: Boolean(f.atRiskOnly) };
  }
}
