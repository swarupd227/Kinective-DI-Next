// Loan growth from what members' own accounts show: transactions on their checking accounts over the
// last six months, as the core's history feed delivers them. Recurring ACH payments to another lender
// (an auto finance company, a HELOC servicer, a mortgage servicer) show who borrows elsewhere; payroll
// direct deposits show income. The credit union also ran an auto refinance campaign in July with a
// held-back control group, so the seed carries its members, the refinances it caused, and the outside
// payments that stopped when a loan moved.
import type { GeneratedTenant } from './generate.ts';
import { AS_OF } from './generate.ts';

export const LOAN_GROWTH_DDL = [
  `CREATE TABLE cdm_transaction (
     txn_id BIGINT PRIMARY KEY,
     account_id INT NOT NULL,
     party_id INT NOT NULL,
     post_date DATE NOT NULL,
     amount DECIMAL(12,2) NOT NULL,
     txn_type VARCHAR(12) NOT NULL,
     description VARCHAR(80) NOT NULL,
     counterparty VARCHAR(60) NOT NULL,
     KEY ix_txn_party (party_id, post_date),
     KEY ix_txn_type (txn_type, post_date)
   )`,
  // A measured outreach campaign: who was chosen, by segment, and whether each was contacted or held back.
  `CREATE TABLE lg_campaign (
     campaign_id INT AUTO_INCREMENT PRIMARY KEY,
     name VARCHAR(80) NOT NULL,
     segments VARCHAR(200) NOT NULL,
     holdout_pct DECIMAL(5,2) NOT NULL,
     treatment INT NOT NULL,
     control INT NOT NULL,
     status VARCHAR(20) NOT NULL,
     created_by VARCHAR(80) NOT NULL,
     created_on DATE NOT NULL,
     sent_on DATE NULL,
     push_id INT NULL,
     approval_id VARCHAR(40) NULL
   )`,
  `CREATE TABLE lg_campaign_member (
     campaign_id INT NOT NULL,
     party_id INT NOT NULL,
     segment VARCHAR(30) NOT NULL,
     arm VARCHAR(10) NOT NULL,
     lender VARCHAR(60) NULL,
     est_monthly_saving DECIMAL(10,2) NULL,
     PRIMARY KEY (campaign_id, party_id),
     KEY ix_lg_party (party_id)
   )`,
];
export const LOAN_GROWTH_WRITE_TABLES = ['lg_campaign', 'lg_campaign_member'];

/** A stable number in [0, 1) for a member and a purpose: the seed is the same every run. */
const unit = (id: number, salt: number) => {
  let h = (id * 2654435761 + salt * 40503) >>> 0;
  h ^= h >>> 16;
  h = Math.imul(h, 2246822507) >>> 0;
  h ^= h >>> 13;
  h = Math.imul(h, 3266489909) >>> 0;
  h ^= h >>> 16;
  return (h >>> 0) / 4294967296;
};
const pick = <T>(xs: readonly T[], id: number, salt: number) => xs[Math.floor(unit(id, salt) * xs.length)]!;
const round2 = (n: number) => Math.round(n * 100) / 100;

const AUTO_LENDERS = ['ALLY FINANCIAL', 'CAPITAL ONE AUTO FINANCE', 'TOYOTA MOTOR CREDIT', 'AMERICAN HONDA FINANCE', 'CHASE AUTO FINANCE', 'WELLS FARGO AUTO', 'SANTANDER CONSUMER USA', 'GM FINANCIAL'] as const;
const HELOC_LENDERS = ['BANK OF AMERICA HELOC', 'FIGURE LENDING', 'SPRING EQ', 'US BANK HOME EQUITY', 'PNC HOME EQUITY'] as const;
const MORTGAGE_LENDERS = ['ROCKET MORTGAGE', 'MR COOPER', 'WELLS FARGO HOME MTG', 'PENNYMAC LOAN SVCS', 'UNITED WHOLESALE MTG'] as const;
const CARD_ISSUERS = ['CAPITAL ONE', 'DISCOVER CARD', 'CHASE CARD SERVICES', 'CITI CARD'] as const;
const EMPLOYERS = ['HARBORVIEW MEDICAL CTR', 'COUNTY SCHOOL DISTRICT', 'PORTSIDE LOGISTICS', 'STATE OF WASHINGTON', 'BAYLINE MANUFACTURING', 'NORTHWIND RETAIL', 'CITY OF HARBORVIEW', 'COASTAL ENERGY CO'] as const;

/** The months of history: May to October, the last one up to the build date. */
const MONTHS = ['2026-05', '2026-06', '2026-07', '2026-08', '2026-09', '2026-10'];
/** The July auto refinance campaign, when it went out, and how many were held back. */
export const SEED_CAMPAIGN = { name: 'Auto refinance, July 2026', createdOn: '2026-07-14', sentOn: '2026-07-16', holdoutPct: 10 };

type Row = unknown[];
interface Outside {
  party: number;
  account: number;
  lender: string;
  kind: 'auto' | 'heloc' | 'mortgage' | 'card';
  payment: number;
  day: number;
  /** The day the loan moved to the credit union, if it did: no payments to the old lender from then. */
  movedOn?: string;
}

/**
 * The members paying lenders elsewhere and the July refinance campaign. Called before loans are loaded:
 * the refinances the campaign caused (and the few the control group took anyway) are added as credit
 * union auto loans, and the outside payments stop the month after.
 */
export function planLoanGrowth(t: GeneratedTenant) {
  const parties = t.parties as Row[];
  const loans = t.loans as Row[];
  const deposits = t.deposits as Row[];
  const checking = new Map<number, number>();
  for (const d of deposits) if (d[3] === 'Checking' && d[5] === null && !checking.has(d[1] as number)) checking.set(d[1] as number, d[0] as number);
  // Open loans: close_date (column 7) is empty.
  const has = (cat: string) => new Set(loans.filter((l) => l[4] === cat && l[7] === null).map((l) => l[1] as number));
  const auto = has('Auto');
  const heloc = has('HELOC');
  const mortgage = has('Mortgage');
  const branchOf = new Map(parties.map((p) => [p[0] as number, p[5] as number]));
  const scoreOf = new Map<number, number>();
  for (const l of loans) if (l[13] !== null) scoreOf.set(l[1] as number, Number(l[13]));

  const outside: Outside[] = [];
  for (const [party, account] of checking) {
    if (!auto.has(party) && unit(party, 1) < 0.085) outside.push({ party, account, lender: pick(AUTO_LENDERS, party, 2), kind: 'auto', payment: round2(360 + unit(party, 3) * 420), day: 1 + Math.floor(unit(party, 4) * 27) });
    if (!heloc.has(party) && unit(party, 5) < 0.028) outside.push({ party, account, lender: pick(HELOC_LENDERS, party, 6), kind: 'heloc', payment: round2(180 + unit(party, 7) * 470), day: 1 + Math.floor(unit(party, 8) * 27) });
    if (!mortgage.has(party) && unit(party, 9) < 0.12) outside.push({ party, account, lender: pick(MORTGAGE_LENDERS, party, 10), kind: 'mortgage', payment: round2(1150 + unit(party, 11) * 1450), day: 1 + Math.floor(unit(party, 12) * 14) });
    if (unit(party, 13) < 0.15) outside.push({ party, account, lender: pick(CARD_ISSUERS, party, 14), kind: 'card', payment: round2(60 + unit(party, 15) * 540), day: 1 + Math.floor(unit(party, 16) * 27) });
  }

  // The July campaign: every member paying an auto loan elsewhere then, after the opt-out and
  // recent-contact rules, split at random into the contacted group and a 10% control group.
  const suppressed = (p: number) => p % 9 === 0 || p % 13 === 0;
  const eligible = outside.filter((o) => o.kind === 'auto' && !suppressed(o.party));
  const members: Row[] = [];
  let loanId = Math.max(...loans.map((l) => l[0] as number)) + 1;
  const newLoans: Row[] = [];
  const cuRate = 6.49; // The refinance special in the July email.
  for (const o of eligible) {
    const control = unit(o.party, 20) < SEED_CAMPAIGN.holdoutPct / 100;
    // About 6% of those contacted refinanced with the credit union; under 2% of the control group did anyway.
    const moved = unit(o.party, 21) < (control ? 0.018 : 0.062);
    const saving = round2(o.payment * 0.09);
    members.push([1, o.party, 'auto_elsewhere', control ? 'control' : 'treatment', o.lender, saving]);
    if (!moved) continue;
    const month = pick(['2026-08', '2026-09', '2026-10'], o.party, 22);
    const day = String(3 + Math.floor(unit(o.party, 23) * 12)).padStart(2, '0');
    o.movedOn = `${month}-${day}`;
    // Balance from the payment at the old lender's rate with about three years left.
    const r = 0.085 / 12;
    const balance = round2((o.payment * (1 - Math.pow(1 + r, -38))) / r);
    newLoans.push([loanId++, o.party, branchOf.get(o.party) ?? 1, 3, 'Auto', 0, `${month}-${day}`, null, null, balance, round2(balance * 0.97), cuRate, 0, scoreOf.get(o.party) ?? 705, 88, 48, null]);
  }
  t.loans.push(...newLoans);
  const treatment = members.filter((m) => m[3] === 'treatment').length;
  const campaign = [[1, SEED_CAMPAIGN.name, 'auto_elsewhere', SEED_CAMPAIGN.holdoutPct, treatment, members.length - treatment, 'Sent', 'Dana Lee', SEED_CAMPAIGN.createdOn, SEED_CAMPAIGN.sentOn, null, null]];
  return { outside, campaign, members, refinanced: newLoans.length };
}

/** Six months of checking transactions: the outside loan payments, card payments and payroll. */
export function generateTransactions(plan: ReturnType<typeof planLoanGrowth>, t: GeneratedTenant, digital: Row[]) {
  const rows: Row[] = [];
  let id = 1;
  const last = AS_OF;
  const add = (account: number, party: number, date: string, amount: number, type: string, description: string, counterparty: string) => {
    if (date > last) return;
    rows.push([id++, account, party, date, amount, type, description, counterparty]);
  };
  for (const o of plan.outside) {
    for (const m of MONTHS) {
      if (o.movedOn && `${m}-${String(o.day).padStart(2, '0')}` >= o.movedOn) break;
      // A card payment varies with the statement; a loan payment doesn't.
      const amount = o.kind === 'card' ? round2(o.payment * (0.6 + unit(o.party + Number(m.slice(5)), 30) * 0.9)) : o.payment;
      const tag = o.kind === 'card' ? 'CRCARDPMT' : o.kind === 'mortgage' ? 'MTG PYMT' : o.kind === 'heloc' ? 'HELOC PMT' : 'AUTO PYMT';
      add(o.account, o.party, `${m}-${String(o.day).padStart(2, '0')}`, -amount, 'ACH', `ACH DEBIT ${o.lender} ${tag}`, o.lender);
    }
  }
  // Payroll for members with an active direct deposit: twice a month, August to October.
  const checking = new Map<number, number>();
  for (const d of t.deposits as Row[]) if (d[3] === 'Checking' && d[5] === null && !checking.has(d[1] as number)) checking.set(d[1] as number, d[0] as number);
  for (const d of digital) {
    const party = d[0] as number;
    const account = checking.get(party);
    if (d[6] !== 'active' || !account) continue;
    const employer = pick(EMPLOYERS, party, 40);
    const pay = round2(1050 + unit(party, 41) * 2600);
    for (const m of ['2026-08', '2026-09', '2026-10']) for (const day of ['01', '15']) add(account, party, `${m}-${day}`, pay, 'DD', `DIRECT DEP ${employer} PAYROLL`, employer);
  }
  return rows;
}

