// Campaign history and attribution (DI's Campaign Success): a year of earlier campaigns, so return on
// spend has eight quarters behind it, and account-level attribution: each account opened within 60 days
// of a campaign for its product, credited to that campaign some of the time. That gives profit by product
// and channel, sales by source each day, and each campaign's responses over its window. Demo data
// [Assumption: demo]; drawn with unit() so no other seeded figure moves.
import { AS_OF, unit, type GeneratedTenant } from './generate.ts';

export const CAMPAIGN_HISTORY_DDL = [
  `CREATE TABLE cmp_attribution (campaign_id INT NOT NULL, party_id INT NOT NULL, account_kind VARCHAR(8) NOT NULL, account_id INT NOT NULL, product VARCHAR(40) NOT NULL, opened DATE NOT NULL, amount DECIMAL(14,2) NOT NULL, PRIMARY KEY (account_kind, account_id), KEY ix_attr_campaign (campaign_id), KEY ix_attr_opened (opened))`,
];

/** The account categories a campaign's product fills, for credit unions and banks. */
export const CAMPAIGN_CATEGORIES: Record<string, string[]> = {
  HELOC: ['HELOC'],
  Auto: ['Auto'],
  'Credit Card': ['Credit Card'],
  'First mortgage': ['Mortgage'],
  'Personal Loan': ['Personal', 'Consumer'],
  Certificate: ['Certificates', 'Certificates of Deposit'],
  Checking: ['Checking'],
};
export const ATTRIBUTION_DAYS = 60;

const EARLIER: [name: string, channel: string, product: string, launched: string][] = [
  ['Fall auto rates', 'Postcard', 'Auto', '2024-10-07'],
  ['Holiday card offer', 'Email', 'Credit Card', '2024-11-18'],
  ['Winter certificate', 'Email', 'Certificate', '2025-01-13'],
  ['Tax refund savings', 'Digital', 'Checking', '2025-02-10'],
  ['Spring home equity', 'Postcard', 'HELOC', '2025-03-24'],
  ['First-time buyer seminar', 'Branch', 'First mortgage', '2025-04-21'],
  ['Summer auto', 'Digital', 'Auto', '2025-06-02'],
  ['Back to school checking', 'Branch', 'Checking', '2025-08-04'],
  ['Debt consolidation', 'Email', 'Personal Loan', '2025-09-08'],
];

/** Earlier campaigns, in the same columns as the current ones, with ids after theirs. */
export function earlierCampaigns(firstId: number) {
  return EARLIER.map(([name, channel, product, launched], i) => {
    const id = firstId + i;
    // A branch event reaches a few hundred people; mail, email and digital reach thousands.
    const sent = Math.round(channel === 'Branch' ? 400 + unit(id, 1501) * 600 : 9000 + unit(id, 1501) * 15000);
    const rate = (channel === 'Email' ? 0.008 : channel === 'Branch' ? 0.05 : 0.006) + unit(id, 1502) * 0.006;
    const applications = Math.round(sent * rate);
    const avg = product === 'First mortgage' ? 240_000 : product === 'HELOC' ? 48_000 : product === 'Auto' ? 26_000 : product === 'Personal Loan' ? 9_000 : product === 'Credit Card' ? 3_500 : 0;
    // Smaller than this year's campaigns: the program has grown.
    const loanDollars = Math.round(applications * 0.7 * avg * 0.55);
    const depositDollars = product === 'Certificate' ? applications * 28_000 : product === 'Checking' ? applications * 640 : 0;
    const control = Math.round(sent / 10);
    const controlResponders = Math.round(control * rate * (0.45 + unit(id, 1503) * 0.3));
    const cost = Math.round(sent * (channel === 'Postcard' ? 0.72 : channel === 'Branch' ? 18 : channel === 'Digital' ? 0.55 : 0.08) + (channel === 'Branch' ? 2500 : 900));
    return [id, name, channel, product, sent, applications, loanDollars, control, controlResponders, cost, depositDollars, launched];
  });
}

/** Accounts opened in a campaign's window for its product, a share of them credited to it. */
export function attribution(t: GeneratedTenant, campaigns: unknown[][]) {
  const DAY = 86_400_000;
  const windows = campaigns
    .filter((c) => c[11])
    .map((c) => ({ id: c[0] as number, product: c[3] as string, from: String(c[11]), to: new Date(Date.parse(`${c[11]}T00:00:00Z`) + ATTRIBUTION_DAYS * DAY).toISOString().slice(0, 10), cats: CAMPAIGN_CATEGORIES[c[3] as string] ?? [] }));
  const rows: unknown[][] = [];
  const consider = (kind: string, id: number, party: number, cat: string, open: string, amount: number) => {
    if (open > AS_OF) return;
    const w = windows.filter((x) => x.cats.includes(cat) && open >= x.from && open <= x.to);
    if (!w.length || unit(id, kind === 'loan' ? 1511 : 1512) >= 0.3) return;
    const c = w[Math.floor(unit(id, 1513) * w.length)]!;
    rows.push([c.id, party, kind, id, c.product, open, amount]);
  };
  for (const l of t.loans as unknown[][]) consider('loan', l[0] as number, l[1] as number, String(l[4]), String(l[6]), Number(l[9]));
  for (const d of t.deposits as unknown[][]) consider('deposit', d[0] as number, d[1] as number, String(d[3]), String(d[4]), Number(d[7]));
  return rows;
}
