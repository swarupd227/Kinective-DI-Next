// Loan growth for a credit union: members who pay an auto loan or a HELOC to another lender, found from
// recurring ACH payments on their own checking accounts, and members with the home equity and credit to
// qualify for a HELOC or the credit and income to qualify for an auto loan. A measured outreach campaign
// holds back a random control group in each segment, sends only the rest, and later compares the two:
// the lift is what the outreach caused, not what members would have done anyway.
//
// Targeting from the credit union's own transaction data doesn't use a consumer report, so it isn't a
// prescreened firm offer of credit under the FCRA. The criteria still go through fair lending review.
import type { Pool } from '@dinext/tenant-db';
import { CoreError, type CoreContext } from './referrals.ts';
import { outreachSuppression } from './suppression.ts';

const rows = async <T>(pool: Pool, sql: string, params: unknown[] = []) => (await pool.query(sql, params))[0] as T[];
const day = (d: unknown) => (d instanceof Date ? d.toISOString() : String(d)).slice(0, 10);

export type LgSegment = 'auto_elsewhere' | 'heloc_elsewhere' | 'heloc_equity' | 'auto_credit';
export const LG_SEGMENTS: Record<LgSegment, { label: string; product: 'Auto' | 'HELOC'; short: string }> = {
  auto_elsewhere: { label: 'Paying an auto loan to another lender', product: 'Auto', short: 'auto loans elsewhere' },
  heloc_elsewhere: { label: 'Paying a HELOC to another lender', product: 'HELOC', short: 'HELOCs elsewhere' },
  heloc_equity: { label: 'Home equity and credit for a HELOC, none anywhere', product: 'HELOC', short: 'equity for a HELOC' },
  auto_credit: { label: 'Credit and income for an auto loan, none anywhere', product: 'Auto', short: 'credit for an auto loan' },
};

/** What kind of loan an ACH payee is. Auto finance first, so "Capital One Auto Finance" isn't read as a card. */
const LENDERS: [RegExp, 'auto' | 'heloc' | 'mortgage' | 'card'][] = [
  [/capital one auto|auto financ|ally financial|toyota motor credit|honda financ|chase auto|wells fargo auto|santander consumer|gm financial/i, 'auto'],
  [/heloc|home equity|figure lending|spring eq/i, 'heloc'],
  [/mortgage|mtg|mr cooper|pennymac|loan svcs/i, 'mortgage'],
  [/card|discover|capital one$|citi/i, 'card'],
];
/** The rate DI assumes on an outside loan: finance companies and subprime lenders charge more. */
const AUTO_RATE = (lender: string) => (/santander/i.test(lender) ? 13.9 : /toyota|honda|gm financial/i.test(lender) ? 7.9 : 8.6);
const HELOC_RATE = 9.1;
/** An outside auto loan has, on average, about three years left. */
const AUTO_MONTHS_LEFT = 38;
/** Qualifying: a HELOC up to 80% of the home's value, at least $25,000 available, and a 700 score; an auto loan with a 700 score and $3,000 a month in direct deposits. */
export const LG_RULES = { cltvMaxPct: 80, minLine: 25_000, maxLine: 150_000, minScore: 700, minMonthlyPay: 3_000, recurringMonths: 3, stoppedDays: 45 };
/** What an incremental dollar is worth: contribution a year and years on the books, as in Campaigns. */
const VALUE: Record<'Auto' | 'HELOC', [number, number]> = { Auto: [0.0185, 2.5], HELOC: [0.034, 4] };

const kindOf = (counterparty: string) => LENDERS.find(([re]) => re.test(counterparty))?.[1] ?? null;
const payment = (balance: number, ratePct: number, months: number) => {
  const r = ratePct / 1200;
  return (balance * r) / (1 - Math.pow(1 + r, -months));
};

export interface LgProspect {
  partyId: number;
  name: string;
  segment: LgSegment;
  lender: string | null;
  monthlyPayment: number | null;
  estBalance: number;
  outsideRate: number | null;
  /** What the member would save a month at the credit union's rate (outside loans), or the line they qualify for (equity). */
  estMonthlySaving: number | null;
  line: number | null;
  score: number | null;
  email: boolean;
}

export class LoanGrowthService {
  constructor(private readonly pool: Pool) {}

  /** The credit union's current rates on new auto loans and HELOCs, from the latest month's production. */
  async rates() {
    const list = await rows<{ c: string; r: number }>(this.pool, 'SELECT loan_category AS c, SUM(new_rate_weighted) / NULLIF(SUM(new_loan_amount), 0) AS r FROM hist_loan_month WHERE month_end = (SELECT MAX(month_end) FROM hist_loan_month) AND loan_category IN (?) GROUP BY loan_category', [['Auto', 'HELOC']]);
    const get = (c: string, d: number) => Number(list.find((x) => x.c === c)?.r ?? d);
    return { Auto: get('Auto', 7.25), HELOC: get('HELOC', 7.7) };
  }

  async asOf() {
    const [b] = await rows<{ d: unknown }>(this.pool, 'SELECT MAX(as_of_date) AS d FROM meta_build');
    return day(b?.d ?? '2026-10-25');
  }

  /** Recurring ACH payments to other lenders: three or more of the last six months, steady, and still going. */
  async outside() {
    const asOf = await this.asOf();
    const list = await rows<{ party_id: number; counterparty: string; months: number; avg: number; sd: number; last: unknown }>(
      this.pool,
      `SELECT party_id, counterparty, COUNT(DISTINCT DATE_FORMAT(post_date, '%Y-%m')) AS months, AVG(-amount) AS avg, STDDEV_POP(-amount) AS sd, MAX(post_date) AS last
         FROM cdm_transaction WHERE txn_type = 'ACH' AND amount < 0 AND post_date > DATE_SUB(?, INTERVAL 6 MONTH) GROUP BY party_id, counterparty`,
      [asOf],
    ).catch(() => null);
    if (list === null) return null;
    const cutoff = new Date(`${asOf}T00:00:00Z`);
    cutoff.setUTCDate(cutoff.getUTCDate() - LG_RULES.stoppedDays);
    const out: { partyId: number; lender: string; kind: 'auto' | 'heloc' | 'mortgage'; payment: number; last: string; stopped: boolean }[] = [];
    let cards = 0;
    for (const r of list) {
      const kind = kindOf(r.counterparty);
      if (!kind) continue;
      // A card payment changes with the statement, so it isn't a loan; the same amount each month is.
      if (kind === 'card' || Number(r.sd) / Number(r.avg) > 0.05) {
        if (kind === 'card') cards++;
        continue;
      }
      if (Number(r.months) < LG_RULES.recurringMonths) continue;
      const last = day(r.last);
      out.push({ partyId: Number(r.party_id), lender: r.counterparty, kind, payment: Number(r.avg), last, stopped: last < cutoff.toISOString().slice(0, 10) });
    }
    return { asOf, payments: out, cardIssuersIgnored: cards };
  }

  /** Every prospect by segment, with what's been excluded and why. */
  async prospects(ctx: CoreContext) {
    const o = await this.outside();
    if (!o) throw new CoreError('NOT_FOUND', 'No transaction history is loaded, so DI can’t see payments to other lenders yet. It needs the core’s transaction feed.');
    const rates = await this.rates();
    const scope = ctx.purviewBranches ? ' AND b.name IN (?)' : '';
    const scopeArgs = ctx.purviewBranches ? [ctx.purviewBranches.length ? ctx.purviewBranches : ['']] : [];
    const members = await rows<{ party_id: number; first_name: string; last_name: string; birth_date: unknown; email: string | null }>(this.pool, `SELECT p.party_id, p.first_name, p.last_name, p.birth_date, c.email FROM cdm_party p JOIN cdm_location b ON b.int_id = p.primary_branch_id LEFT JOIN cdm_party_contact c ON c.party_id = p.party_id WHERE p.is_member = 1${scope}`, scopeArgs);
    const who = new Map(members.map((m) => [m.party_id, m]));
    const loans = await rows<{ party_id: number; c: string; balance: number; original_amount: number; ltv: number | null; score: number | null; dpd: number; open_date: unknown }>(this.pool, 'SELECT party_id, loan_category AS c, balance, original_amount, ltv, credit_score AS score, days_delinquent AS dpd, open_date FROM cdm_loan WHERE close_date IS NULL AND charge_off_date IS NULL');
    const chargedOff = new Set((await rows<{ party_id: number }>(this.pool, 'SELECT DISTINCT party_id FROM cdm_loan WHERE close_date IS NULL AND charge_off_date IS NOT NULL')).map((r) => Number(r.party_id)));
    const byParty = new Map<number, typeof loans>();
    for (const l of loans) byParty.set(l.party_id, [...(byParty.get(l.party_id) ?? []), l]);
    const pay = await rows<{ party_id: number; monthly: number }>(this.pool, `SELECT party_id, SUM(amount) / 3 AS monthly FROM cdm_transaction WHERE txn_type = 'DD' AND post_date > DATE_SUB(?, INTERVAL 3 MONTH) GROUP BY party_id`, [o.asOf]);
    const income = new Map(pay.map((p) => [p.party_id, Number(p.monthly)]));
    const elsewhere = new Map<number, typeof o.payments>();
    for (const p of o.payments.filter((x) => !x.stopped)) elsewhere.set(p.partyId, [...(elsewhere.get(p.partyId) ?? []), p]);

    const all: LgProspect[] = [];
    const excluded = { delinquent: 0, deceased: 0, optOut: 0, recentContact: 0 };
    const suppressed = await outreachSuppression(this.pool);
    const score = (ls: typeof loans) => {
      const s = [...ls].filter((l) => l.score !== null).sort((a, b) => day(b.open_date).localeCompare(day(a.open_date)))[0];
      return s ? Number(s.score) : null;
    };
    const holdsCu = (ls: typeof loans, c: string) => ls.some((l) => l.c === c);
    for (const [partyId, m] of who) {
      const ls = byParty.get(partyId) ?? [];
      const out = elsewhere.get(partyId) ?? [];
      const found: Omit<LgProspect, 'partyId' | 'name' | 'email' | 'score'>[] = [];
      for (const p of out) {
        if (p.kind === 'auto' && !holdsCu(ls, 'Auto')) {
          const rate = AUTO_RATE(p.lender);
          const r = rate / 1200;
          const balance = (p.payment * (1 - Math.pow(1 + r, -AUTO_MONTHS_LEFT))) / r;
          found.push({ segment: 'auto_elsewhere', lender: p.lender, monthlyPayment: p.payment, estBalance: balance, outsideRate: rate, estMonthlySaving: Math.max(0, p.payment - payment(balance, rates.Auto, AUTO_MONTHS_LEFT)), line: null });
        }
        if (p.kind === 'heloc' && !holdsCu(ls, 'HELOC')) {
          // A HELOC in its draw period pays interest only: the payment gives the balance.
          const balance = (p.payment * 12) / (HELOC_RATE / 100);
          found.push({ segment: 'heloc_elsewhere', lender: p.lender, monthlyPayment: p.payment, estBalance: balance, outsideRate: HELOC_RATE, estMonthlySaving: Math.max(0, (balance * (HELOC_RATE - rates.HELOC)) / 1200), line: null });
        }
      }
      const s = score(ls);
      const helocAnywhere = holdsCu(ls, 'HELOC') || out.some((p) => p.kind === 'heloc');
      const mortgage = ls.find((l) => l.c === 'Mortgage' && l.ltv !== null && Number(l.ltv) > 0);
      if (mortgage && !helocAnywhere && s !== null && s >= LG_RULES.minScore) {
        // The home's value from the mortgage's loan-to-value at origination; an automated valuation would refresh it.
        const value = Number(mortgage.original_amount) / (Number(mortgage.ltv) / 100);
        const available = (value * LG_RULES.cltvMaxPct) / 100 - Number(mortgage.balance);
        if (available >= LG_RULES.minLine) found.push({ segment: 'heloc_equity', lender: null, monthlyPayment: null, estBalance: 0, outsideRate: null, estMonthlySaving: null, line: Math.min(LG_RULES.maxLine, Math.floor(available / 1000) * 1000) });
      }
      const age = (Date.parse(o.asOf) - Date.parse(day(m.birth_date))) / (365.25 * 86_400_000);
      if (!holdsCu(ls, 'Auto') && !out.some((p) => p.kind === 'auto') && s !== null && s >= LG_RULES.minScore && (income.get(partyId) ?? 0) >= LG_RULES.minMonthlyPay && age >= 21) {
        found.push({ segment: 'auto_credit', lender: null, monthlyPayment: null, estBalance: 0, outsideRate: null, estMonthlySaving: null, line: null });
      }
      if (!found.length) continue;
      // Members behind on a loan with the credit union, who opted out or were contacted recently, are left out, and counted.
      // A loan with us that was charged off still on the books counts as behind: no new credit offer.
      if (ls.some((l) => Number(l.dpd) >= 30) || chargedOff.has(partyId)) {
        excluded.delinquent++;
        continue;
      }
      const sup = suppressed(partyId);
      if (sup) {
        excluded[sup === 'deceased' ? 'deceased' : sup === 'opt_out' ? 'optOut' : 'recentContact']++;
        continue;
      }
      // One segment a member: an outside loan they already pay comes before what they could qualify for.
      const order: LgSegment[] = ['auto_elsewhere', 'heloc_elsewhere', 'heloc_equity', 'auto_credit'];
      const best = [...found].sort((a, b) => order.indexOf(a.segment) - order.indexOf(b.segment))[0]!;
      all.push({ ...best, partyId, name: `${m.first_name} ${m.last_name.charAt(0)}.`, email: Boolean(m.email), score: s });
    }
    const homeownersElsewhere = new Set(o.payments.filter((p) => p.kind === 'mortgage' && !p.stopped).map((p) => p.partyId)).size;
    const segments = (Object.keys(LG_SEGMENTS) as LgSegment[]).map((k) => {
      const xs = all.filter((p) => p.segment === k);
      return { segment: k, ...LG_SEGMENTS[k], members: xs.length, estBalance: xs.reduce((t, p) => t + p.estBalance, 0), estMonthlySaving: xs.length && xs.some((p) => p.estMonthlySaving !== null) ? xs.reduce((t, p) => t + (p.estMonthlySaving ?? 0), 0) / xs.length : null, lines: xs.reduce((t, p) => t + (p.line ?? 0), 0), emailable: xs.filter((p) => p.email).length };
    });
    const lenders = new Map<string, number>();
    for (const p of all.filter((x) => x.lender)) lenders.set(p.lender!, (lenders.get(p.lender!) ?? 0) + 1);
    return { asOf: o.asOf, rates, prospects: all, segments, excluded, homeownersElsewhere, cardIssuersIgnored: o.cardIssuersIgnored, lenders: [...lenders].map(([lender, n]) => ({ lender, members: n })).sort((a, b) => b.members - a.members) };
  }

  /**
   * Splits prospects into the contacted group and a control group, at random within each segment, so the
   * two match. The split is fixed by the seed: the same request gives the same groups.
   */
  static split<T extends { partyId: number; segment: string }>(prospects: T[], holdoutPct: number, seed: string) {
    let h = 2166136261;
    for (const c of seed) h = Math.imul(h ^ c.charCodeAt(0), 16777619) >>> 0;
    const rank = (id: number) => {
      let x = (id ^ h) >>> 0;
      x = Math.imul(x ^ (x >>> 16), 2246822507) >>> 0;
      x = Math.imul(x ^ (x >>> 13), 3266489909) >>> 0;
      return (x ^ (x >>> 16)) >>> 0;
    };
    const out: (T & { arm: 'treatment' | 'control' })[] = [];
    for (const seg of [...new Set(prospects.map((p) => p.segment))]) {
      const xs = prospects.filter((p) => p.segment === seg).sort((a, b) => rank(a.partyId) - rank(b.partyId));
      const control = Math.round((xs.length * holdoutPct) / 100);
      xs.forEach((p, i) => out.push({ ...p, arm: i < control ? 'control' : 'treatment' }));
    }
    return out;
  }

  /** Saves a prepared campaign and its two groups. Called once the plan is approved. */
  async record(p: { name: string; segments: LgSegment[]; holdoutPct: number; members: { partyId: number; segment: LgSegment; arm: 'treatment' | 'control'; lender: string | null; saving: number | null }[] }, meta: { approvalId: string; by: string }) {
    const treatment = p.members.filter((m) => m.arm === 'treatment').length;
    const [r] = (await this.pool.query('INSERT INTO lg_campaign (name, segments, holdout_pct, treatment, control, status, created_by, created_on, approval_id) VALUES (?, ?, ?, ?, ?, ?, ?, CURRENT_DATE, ?)', [p.name.slice(0, 80), p.segments.join(','), p.holdoutPct, treatment, p.members.length - treatment, 'Prepared', meta.by, meta.approvalId])) as unknown as [{ insertId: number }];
    const values = p.members.map((m) => [r.insertId, m.partyId, m.segment, m.arm, m.lender, m.saving === null ? null : Math.round(m.saving * 100) / 100]);
    for (let i = 0; i < values.length; i += 2000) await this.pool.query('INSERT INTO lg_campaign_member (campaign_id, party_id, segment, arm, lender, est_monthly_saving) VALUES ?', [values.slice(i, i + 2000)]);
    return r.insertId;
  }

  async campaigns() {
    const list = await rows<{ campaign_id: number; name: string; segments: string; holdout_pct: number; treatment: number; control: number; status: string; created_by: string; created_on: unknown; sent_on: unknown; push_id: number | null }>(this.pool, 'SELECT * FROM lg_campaign ORDER BY campaign_id').catch(() => []);
    return list.map((c) => ({ id: Number(c.campaign_id), name: c.name, segments: c.segments.split(',') as LgSegment[], holdoutPct: Number(c.holdout_pct), treatment: Number(c.treatment), control: Number(c.control), status: c.status, by: c.created_by, createdOn: day(c.created_on), sentOn: c.sent_on ? day(c.sent_on) : null, pushId: c.push_id }));
  }

  /** The contacted members who can be emailed, for the marketing platform: the control group never goes. */
  async treatmentMembers(campaignId: number) {
    return rows<{ partyId: number; firstName: string; email: string }>(this.pool, "SELECT m.party_id AS partyId, p.first_name AS firstName, c.email FROM lg_campaign_member m JOIN cdm_party p ON p.party_id = m.party_id JOIN cdm_party_contact c ON c.party_id = m.party_id WHERE m.campaign_id = ? AND m.arm = 'treatment' AND c.email IS NOT NULL ORDER BY m.party_id", [campaignId]);
  }

  async markSent(campaignId: number, pushId: number | null) {
    await this.pool.query("UPDATE lg_campaign SET status = 'Sent', sent_on = CURRENT_DATE, push_id = ? WHERE campaign_id = ?", [pushId, campaignId]);
  }

  /**
   * Did the campaign work? A member responded when they opened the product with the credit union after
   * the campaign went out. Lift is the contacted group's rate less the control group's; a two-proportion
   * test says whether the difference is more than chance.
   */
  async results(campaignId: number) {
    const c = (await this.campaigns()).find((x) => x.id === campaignId);
    if (!c) throw new CoreError('NOT_FOUND', 'There’s no loan growth campaign with that number.');
    const since = c.sentOn ?? c.createdOn;
    const arms = await rows<{ arm: string; segment: string; n: number; responders: number; dollars: number; moved: number }>(
      this.pool,
      `SELECT m.arm, m.segment, COUNT(*) AS n,
              SUM(r.party_id IS NOT NULL) AS responders, COALESCE(SUM(r.amount), 0) AS dollars,
              SUM(r.party_id IS NOT NULL AND m.lender IS NOT NULL AND NOT EXISTS (SELECT 1 FROM cdm_transaction t WHERE t.party_id = m.party_id AND t.counterparty = m.lender AND t.post_date > r.opened)) AS moved
         FROM lg_campaign_member m
         LEFT JOIN (SELECT party_id, loan_category, MIN(open_date) AS opened, SUM(original_amount) AS amount FROM cdm_loan WHERE open_date >= ? GROUP BY party_id, loan_category) r
           ON r.party_id = m.party_id AND r.loan_category = CASE WHEN m.segment LIKE 'auto%' THEN 'Auto' ELSE 'HELOC' END
        WHERE m.campaign_id = ? GROUP BY m.arm, m.segment`,
      [since, campaignId],
    );
    const sum = (arm: string, k: 'n' | 'responders' | 'dollars' | 'moved', seg?: string) => arms.filter((a) => a.arm === arm && (!seg || a.segment === seg)).reduce((t, a) => t + Number(a[k]), 0);
    const measure = (seg?: string) => {
      const nT = sum('treatment', 'n', seg);
      const nC = sum('control', 'n', seg);
      const rT = nT ? sum('treatment', 'responders', seg) / nT : 0;
      const rC = nC ? sum('control', 'responders', seg) / nC : 0;
      const pooled = nT + nC ? (sum('treatment', 'responders', seg) + sum('control', 'responders', seg)) / (nT + nC) : 0;
      const se = Math.sqrt(pooled * (1 - pooled) * (1 / Math.max(nT, 1) + 1 / Math.max(nC, 1)));
      const z = se ? (rT - rC) / se : 0;
      const incremental = Math.max(0, (rT - rC) * nT);
      const responders = sum('treatment', 'responders', seg);
      const avgLoan = responders ? sum('treatment', 'dollars', seg) / responders : 0;
      const product: 'Auto' | 'HELOC' = !seg || seg.startsWith('auto') ? 'Auto' : 'HELOC';
      const [margin, years] = VALUE[product];
      return { treatment: nT, control: nC, treatmentRatePct: rT * 100, controlRatePct: rC * 100, liftPts: (rT - rC) * 100, z, significant: Math.abs(z) >= 1.96, responders, controlResponders: sum('control', 'responders', seg), incremental, incrementalDollars: incremental * avgLoan, value: incremental * avgLoan * margin * years, moved: sum('treatment', 'moved', seg) + sum('control', 'moved', seg) };
    };
    return { campaign: c, since, total: measure(), bySegment: c.segments.map((s) => ({ segment: s, label: LG_SEGMENTS[s]?.label ?? s, ...measure(s) })) };
  }

  assumptions(): [string, string][] {
    return [
      ['Loans elsewhere', `Recurring ACH debits from members’ checking accounts to auto finance companies and HELOC servicers: the same amount in at least ${LG_RULES.recurringMonths} of the last six months, and paid within the last ${LG_RULES.stoppedDays} days. Card payments vary with the statement and aren’t loans; mortgage servicers mark a homeowner.`],
      ['Outside balances and rates', `Not on the payment, so estimated: an auto loan at ${8.6}% (7.9% at a manufacturer’s finance company, 13.9% at a subprime lender) with about ${AUTO_MONTHS_LEFT} months left; a HELOC at ${HELOC_RATE}% paying interest only. The saving is the payment difference at the credit union’s current rate for the same term.`],
      ['Qualifying for a HELOC', `A mortgage with the credit union, the home’s value from its loan-to-value at origination, up to ${LG_RULES.cltvMaxPct}% of it less the mortgage, at least $${LG_RULES.minLine.toLocaleString('en-US')} available (offered up to $${LG_RULES.maxLine.toLocaleString('en-US')}), a ${LG_RULES.minScore}+ score on the latest loan, and no HELOC anywhere. Homeowners who pay a mortgage elsewhere need a home value feed (an automated valuation) before DI can size their equity.`],
      ['Qualifying for an auto loan', `No auto loan anywhere, a ${LG_RULES.minScore}+ score on the latest credit union loan, at least $${LG_RULES.minMonthlyPay.toLocaleString('en-US')} a month in payroll direct deposits, and aged 21 or over. Members with no loan at the credit union have no score on file; a periodic bureau score would add them.`],
      ['Left out', 'Members 30 or more days late on a credit union loan, members who opted out of marketing and members contacted in the last 30 days. Each member is in one segment: a loan they already pay elsewhere comes first.'],
      ['Control group', 'Chosen at random within each segment and never contacted, so both groups match. Lift is the contacted group’s rate of opening the product less the control group’s; a two-proportion test says whether it is more than chance.'],
      ['Compliance', 'Built from the credit union’s own transaction data, not a consumer report, so it isn’t a prescreened firm offer of credit under the FCRA; using bureau data to choose members would make it one. The criteria should go through fair lending review, and advertised rates need Reg Z’s disclosures.'],
    ];
  }
}
