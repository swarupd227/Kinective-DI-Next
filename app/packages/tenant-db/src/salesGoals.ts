// Sales goals beyond the incentive scorecards: the year's loan goals by channel, with a minimum and a
// stretch (DI's Monthly Loan Score Card), and short sales contests. Goals come from this year's own pace,
// so some channels run ahead and some behind. Demo data [Assumption: demo].
import { AS_OF, unit, type GeneratedTenant } from './generate.ts';

export const SALES_GOALS_DDL = [
  `CREATE TABLE fin_loan_goal (year INT NOT NULL, channel VARCHAR(40) NOT NULL, minimum DECIMAL(16,2) NOT NULL, stretch DECIMAL(16,2) NOT NULL, sort_order INT NOT NULL, PRIMARY KEY (year, channel))`,
  `CREATE TABLE gi_contest (contest_id INT PRIMARY KEY, name VARCHAR(80) NOT NULL, categories JSON NOT NULL, metric VARCHAR(10) NOT NULL, by_level VARCHAR(10) NOT NULL, starts DATE NOT NULL, ends DATE NOT NULL, prize VARCHAR(160) NOT NULL)`,
];

/** The channel a loan counts toward on the loan scorecard. */
export function loanChannel(category: string, indirect: boolean): string {
  if (category === 'Auto') return indirect ? 'Indirect (dealers)' : 'Consumer direct: vehicle';
  if (category === 'Credit Card') return 'Credit cards';
  if (category === 'Mortgage') return 'Real estate: first mortgage';
  if (category === 'HELOC') return 'Real estate: home equity';
  if (category === 'Business' || category === 'Commercial Real Estate' || category === 'Commercial & Industrial') return 'Commercial';
  return 'Consumer direct: other';
}
export const CHANNEL_ORDER = ['Commercial', 'Consumer direct: vehicle', 'Indirect (dealers)', 'Consumer direct: other', 'Credit cards', 'Real estate: first mortgage', 'Real estate: home equity'];

export function generateSalesGoals(t: GeneratedTenant, bank: boolean) {
  const year = Number(AS_OF.slice(0, 4));
  const through = `${year}-09-30`;
  const ytd = new Map<string, number>();
  for (const l of t.loans as unknown[][]) {
    const open = String(l[6]);
    if (open < `${year}-01-01` || open > through) continue;
    const ch = loanChannel(String(l[4]), Boolean(l[5]));
    ytd.set(ch, (ytd.get(ch) ?? 0) + Number(l[9]));
  }
  // The minimum is the year's pace, give or take; the stretch is a fifth above it.
  const goals = CHANNEL_ORDER.filter((ch) => ytd.has(ch)).map((ch, i) => {
    const pace = (ytd.get(ch)! * 12) / 9;
    const minimum = Math.round((pace * (0.9 + unit(i + 1, 1401) * 0.18)) / 1000) * 1000;
    return [year, ch, minimum, Math.round((minimum * 1.2) / 1000) * 1000, i];
  });
  const contests = [
    [1, 'Auto loan summer drive', JSON.stringify(['Auto']), 'count', 'officer', `${year}-06-01`, `${year}-08-31`, '$250 to each of the top three loan officers'],
    bank
      ? [2, 'Home loan fall push', JSON.stringify(['Mortgage']), 'dollars', 'branch', `${year}-09-15`, `${year}-11-30`, 'A team lunch for the top branch']
      : [2, 'HELOC fall push', JSON.stringify(['HELOC']), 'dollars', 'branch', `${year}-09-15`, `${year}-11-30`, 'A team lunch for the top branch'],
  ];
  return { goals, contests };
}
