// Profitability by product and branch, by funds transfer pricing (FTP): each loan pays for the funding
// it uses, at a rate for its term, and each deposit earns a credit for the funding it provides. What is
// left after interest, the FTP charge or credit, the expected credit loss, servicing cost and fees is the
// product's contribution before overhead. The allowance by segment spreads the allowance reported on the
// latest Call Report (5300 or FFIEC 051) across loan types and credit bands by each pool's loss rate, so
// it reconciles to the filed figure.
//
// The FTP curve, loss rates, servicing costs and fees are DI's standard assumptions for a community
// institution, shown with every answer; the institution's own FTP and cost allocations replace them.
import type { Pool } from '@dinext/tenant-db';

const rows = async <T>(pool: Pool, sql: string, params: unknown[] = []) => (await pool.query(sql, params))[0] as T[];

/** The FTP rate a loan is charged for its funding, by contractual term (revolving credit is short). */
export const FTP_CURVE: [maxMonths: number, ratePct: number][] = [
  [12, 3.75],
  [36, 3.7],
  [60, 3.72],
  [84, 3.8],
  [180, 3.95],
  [9999, 4.1],
];
const ftpFor = (term: number | null) => FTP_CURVE.find(([m]) => (term ?? 12) <= m)![1];

/** The credit a deposit earns for its funding: core deposits are worth long-term money, certificates their term. */
const DEPOSIT_FTP: Record<string, number> = { Checking: 3.55, 'Share Savings': 3.45, Savings: 3.45, 'Money Market': 3.5, Certificates: 3.85, 'Certificates of Deposit': 3.85, IRA: 3.9 };

/** Annual expected loss on today's balance, by product: through-the-cycle rates for a community lender. */
export const LOSS_RATE: Record<string, number> = { Mortgage: 0.05, HELOC: 0.15, Auto: 0.55, Personal: 2.3, 'Credit Card': 3.1, Consumer: 2.0, Business: 0.5, 'Commercial Real Estate': 0.25, 'Commercial & Industrial': 0.6 };
/** Expected remaining life in years: CECL losses are over a loan's life, long for mortgages, short for cards. */
export const LIFE_YEARS: Record<string, number> = { Mortgage: 7, HELOC: 4.5, Auto: 2.2, Personal: 1.9, 'Credit Card': 1.5, Consumer: 1.9, Business: 3, 'Commercial Real Estate': 4.5, 'Commercial & Industrial': 2.5 };
/** Servicing cost and fee income per account per year. */
const LOAN_COST: Record<string, [cost: number, fees: number]> = { Mortgage: [620, 140], HELOC: [310, 60], Auto: [190, 25], Personal: [170, 30], 'Credit Card': [95, 70], Consumer: [160, 25], Business: [1800, 450], 'Commercial Real Estate': [3600, 900], 'Commercial & Industrial': [2600, 700] };
const DEPOSIT_COST: Record<string, [cost: number, fees: number]> = { Checking: [165, 120], 'Share Savings': [38, 6], Savings: [38, 6], 'Money Market': [70, 10], Certificates: [45, 4], 'Certificates of Deposit': [45, 4], IRA: [60, 4] };

/** How much more a weaker credit band loses than the product's average. */
export const BAND_FACTOR = (score: number | null, rating: number | null) => (rating !== null ? (rating >= 7 ? 6 : rating === 6 ? 3 : 0.8) : score === null ? 1 : score >= 740 ? 0.45 : score >= 680 ? 0.9 : score >= 620 ? 2.1 : 4.2);
export const bandName = (score: number | null, rating: number | null) => (rating !== null ? (rating >= 7 ? 'Substandard (7)' : rating === 6 ? 'Special mention (6)' : 'Pass (1–5)') : score === null ? 'Not scored' : score >= 740 ? 'Super prime (740+)' : score >= 680 ? 'Prime (680–739)' : score >= 620 ? 'Near prime (620–679)' : 'Subprime (under 620)');

export interface ProfitLine {
  name: string;
  side: 'loan' | 'deposit';
  balance: number;
  accounts: number;
  interest: number;
  ftp: number;
  credit: number;
  servicing: number;
  fees: number;
  contribution: number;
  /** Contribution as a share of balance, annualized. */
  marginPct: number;
}

export class ProfitabilityService {
  constructor(
    private readonly pool: Pool,
    private readonly institutionType: 'credit_union' | 'bank' = 'credit_union',
  ) {}

  private async book(branches?: string[]) {
    const where = branches?.length ? ` AND loc.name IN (${branches.map(() => '?').join(', ')})` : '';
    const loans = await rows<{ branch: string; category: string; balance: number; rate: number; term: number | null; score: number | null; rating: number | null; dpd: number }>(
      this.pool,
      `SELECT loc.name AS branch, l.loan_category AS category, l.balance, l.rate, l.term_months AS term, l.credit_score AS score, l.risk_rating AS rating, l.days_delinquent AS dpd FROM cdm_loan l JOIN cdm_location loc ON loc.int_id = l.branch_id WHERE l.close_date IS NULL AND l.charge_off_date IS NULL AND l.balance > 0${where}`,
      branches ?? [],
    );
    const deposits = await rows<{ branch: string; category: string; balance: number; rate: number }>(this.pool, `SELECT loc.name AS branch, d.deposit_category AS category, d.balance, d.rate FROM cdm_deposit_account d JOIN cdm_location loc ON loc.int_id = d.branch_id WHERE d.close_date IS NULL AND d.balance > 0${where}`, branches ?? []);
    return { loans, deposits };
  }

  /**
   * Profitability per member: each account's contribution by the same FTP, credit, servicing and fee
   * assumptions, summed by the person who owns it. Annualized on today's balances.
   */
  async members(branches?: string[]) {
    const where = branches?.length ? ` AND loc.name IN (${branches.map(() => '?').join(', ')})` : '';
    const loans = await rows<{ party_id: number; category: string; balance: number; rate: number; term: number | null; score: number | null; rating: number | null }>(
      this.pool,
      `SELECT l.party_id, l.loan_category AS category, l.balance, l.rate, l.term_months AS term, l.credit_score AS score, l.risk_rating AS rating FROM cdm_loan l JOIN cdm_location loc ON loc.int_id = l.branch_id WHERE l.close_date IS NULL AND l.charge_off_date IS NULL AND l.balance > 0${where}`,
      branches ?? [],
    );
    const deposits = await rows<{ party_id: number; category: string; balance: number; rate: number }>(this.pool, `SELECT d.party_id, d.deposit_category AS category, d.balance, d.rate FROM cdm_deposit_account d JOIN cdm_location loc ON loc.int_id = d.branch_id WHERE d.close_date IS NULL${where}`, branches ?? []);
    const by = new Map<number, { contribution: number; loans: number; deposits: number; accounts: number }>();
    const at = (id: number) => by.get(id) ?? by.set(id, { contribution: 0, loans: 0, deposits: 0, accounts: 0 }).get(id)!;
    for (const l of loans) {
      const bal = Number(l.balance);
      const [cost, fees] = LOAN_COST[l.category] ?? [200, 30];
      const c = (bal * Number(l.rate)) / 100 - (bal * ftpFor(l.term === null ? null : Number(l.term))) / 100 - (bal * (LOSS_RATE[l.category] ?? 0.5) * BAND_FACTOR(l.score === null ? null : Number(l.score), l.rating === null ? null : Number(l.rating))) / 100 - cost + fees;
      const m = at(l.party_id);
      m.contribution += c;
      m.loans += bal;
      m.accounts++;
    }
    for (const d of deposits) {
      const bal = Number(d.balance);
      const [cost, fees] = DEPOSIT_COST[d.category] ?? [60, 5];
      const c = -(bal * Number(d.rate)) / 100 + (bal * (DEPOSIT_FTP[d.category] ?? 3.5)) / 100 - cost + fees;
      const m = at(d.party_id);
      m.contribution += c;
      m.deposits += bal;
      m.accounts++;
    }
    return [...by.entries()].map(([partyId, m]) => ({ partyId, contribution: Math.round(m.contribution), loans: Math.round(m.loans), deposits: Math.round(m.deposits), accounts: m.accounts }));
  }

  /** Contribution before overhead, by product, then by branch: annualized on today's balances. */
  async analysis(branches?: string[]) {
    const { loans, deposits } = await this.book(branches);
    const blank = (name: string, side: 'loan' | 'deposit'): ProfitLine => ({ name, side, balance: 0, accounts: 0, interest: 0, ftp: 0, credit: 0, servicing: 0, fees: 0, contribution: 0, marginPct: 0 });
    const products = new Map<string, ProfitLine>();
    const branchLines = new Map<string, ProfitLine>();
    const add = (map: Map<string, ProfitLine>, key: string, side: 'loan' | 'deposit', x: Omit<ProfitLine, 'name' | 'side' | 'marginPct' | 'contribution'>) => {
      const line = map.get(key) ?? blank(key, side);
      line.balance += x.balance;
      line.accounts += x.accounts;
      line.interest += x.interest;
      line.ftp += x.ftp;
      line.credit += x.credit;
      line.servicing += x.servicing;
      line.fees += x.fees;
      map.set(key, line);
    };
    for (const l of loans) {
      const bal = Number(l.balance);
      const [cost, fees] = LOAN_COST[l.category] ?? [200, 30];
      // Interest earned less the FTP charge: a loan's spread. Credit cost is its expected annual loss, higher in weaker bands.
      const x = { balance: bal, accounts: 1, interest: (bal * Number(l.rate)) / 100, ftp: -(bal * ftpFor(l.term === null ? null : Number(l.term))) / 100, credit: -(bal * (LOSS_RATE[l.category] ?? 0.5) * BAND_FACTOR(l.score === null ? null : Number(l.score), l.rating === null ? null : Number(l.rating))) / 100, servicing: -cost, fees };
      add(products, l.category, 'loan', x);
      add(branchLines, l.branch, 'loan', x);
    }
    for (const d of deposits) {
      const bal = Number(d.balance);
      const [cost, fees] = DEPOSIT_COST[d.category] ?? [60, 5];
      // A deposit's interest is a cost; the FTP credit is what its funding is worth.
      const x = { balance: bal, accounts: 1, interest: -(bal * Number(d.rate)) / 100, ftp: (bal * (DEPOSIT_FTP[d.category] ?? 3.5)) / 100, credit: 0, servicing: -cost, fees };
      add(products, d.category, 'deposit', x);
      add(branchLines, d.branch, 'deposit', x);
    }
    const finish = (l: ProfitLine) => {
      l.contribution = l.interest + l.ftp + l.credit + l.servicing + l.fees;
      l.marginPct = l.balance ? (l.contribution / l.balance) * 100 : 0;
      return l;
    };
    const byProduct = [...products.values()].map(finish).sort((a, b) => b.contribution - a.contribution);
    // A branch's balance is what it manages, loans and deposits together.
    const byBranch = [...branchLines.values()].map(finish).sort((a, b) => b.contribution - a.contribution);
    const total = byProduct.reduce((s, l) => s + l.contribution, 0);
    return { byProduct, byBranch, total, assumptions: this.assumptions() };
  }

  /** The allowance by pool (loan type and credit band), scaled to the allowance on the latest filed report. */
  async allowance(branches?: string[]) {
    const { loans } = await this.book(branches);
    const code = this.institutionType === 'bank' ? 'RCON3123' : 'AS0048';
    const [filed] = await rows<{ amount: number }>(this.pool, 'SELECT amount FROM cr_value WHERE code = ? AND quarter_end = (SELECT MAX(quarter_end) FROM cr_value)', [code]).catch(() => []);
    const pools = new Map<string, { category: string; band: string; balance: number; raw: number; dq60: number; count: number }>();
    for (const l of loans) {
      const score = l.score === null ? null : Number(l.score);
      const rating = l.rating === null ? null : Number(l.rating);
      const key = `${l.category}|${bandName(score, rating)}`;
      const p = pools.get(key) ?? { category: l.category, band: bandName(score, rating), balance: 0, raw: 0, dq60: 0, count: 0 };
      const bal = Number(l.balance);
      // A lifetime view: the annual loss rate over the product's remaining life, more for loans already 60+ days behind.
      p.raw += bal * ((LOSS_RATE[l.category] ?? 0.5) / 100) * BAND_FACTOR(score, rating) * (LIFE_YEARS[l.category] ?? 2.5) * (Number(l.dpd) >= 60 ? 4 : 1);
      p.balance += bal;
      p.dq60 += Number(l.dpd) >= 60 ? bal : 0;
      p.count += 1;
      pools.set(key, p);
    }
    const rawTotal = [...pools.values()].reduce((s, p) => s + p.raw, 0);
    // Scaled to the filed allowance when the institution-wide book is shown; a branch's share follows its pools.
    const filedAmount = filed ? Number(filed.amount) : null;
    const scale = filedAmount !== null && !branches?.length && rawTotal ? filedAmount / rawTotal : filedAmount !== null && rawTotal ? filedAmount / (await this.rawAll()) : 1;
    const lines = [...pools.values()]
      .map((p) => ({ category: p.category, band: p.band, balance: p.balance, loans: p.count, allowance: p.raw * scale, coveragePct: p.balance ? ((p.raw * scale) / p.balance) * 100 : 0, dq60Pct: p.balance ? (p.dq60 / p.balance) * 100 : 0 }))
      .sort((a, b) => b.allowance - a.allowance);
    const byCategory = [...new Set(lines.map((l) => l.category))]
      .map((c) => {
        const ls = lines.filter((l) => l.category === c);
        const balance = ls.reduce((s, l) => s + l.balance, 0);
        const allowance = ls.reduce((s, l) => s + l.allowance, 0);
        return { category: c, balance, allowance, coveragePct: balance ? (allowance / balance) * 100 : 0, dq60Pct: balance ? (ls.reduce((s, l) => s + (l.dq60Pct * l.balance) / 100, 0) / balance) * 100 : 0 };
      })
      .sort((a, b) => b.allowance - a.allowance);
    const balance = lines.reduce((s, l) => s + l.balance, 0);
    const allowance = lines.reduce((s, l) => s + l.allowance, 0);
    return { lines, byCategory, balance, allowance, coveragePct: balance ? (allowance / balance) * 100 : 0, filed: filedAmount, filedCode: code, form: this.institutionType === 'bank' ? 'FFIEC 051' : '5300' };
  }

  private async rawAll() {
    const { loans } = await this.book();
    return loans.reduce((s, l) => s + Number(l.balance) * ((LOSS_RATE[l.category] ?? 0.5) / 100) * BAND_FACTOR(l.score === null ? null : Number(l.score), l.rating === null ? null : Number(l.rating)) * (LIFE_YEARS[l.category] ?? 2.5) * (Number(l.dpd) >= 60 ? 4 : 1), 0);
  }

  assumptions() {
    return [
      `Loans are charged for their funding at ${FTP_CURVE[0]![1]}% to ${FTP_CURVE[FTP_CURVE.length - 1]![1]}% by term; deposits earn ${Math.min(...Object.values(DEPOSIT_FTP))}% to ${Math.max(...Object.values(DEPOSIT_FTP))}% for theirs.`,
      'Credit cost is each product’s through-the-cycle annual loss rate, higher in weaker credit bands and for criticized commercial loans.',
      'Servicing cost and fees are standard per-account figures for a community institution.',
      'Contribution is before overhead (executive, finance, IT and premises not tied to a product), so the products add to more than net income.',
    ];
  }
}
