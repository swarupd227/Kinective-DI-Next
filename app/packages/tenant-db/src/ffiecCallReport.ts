// The FFIEC 051 Call Report for the bank tenant, five quarters (Q3 2025 to Q3 2026), from the same loans,
// deposits and month-end history every other page reads, so the report ties to Home. RC-C splits the loan
// book into the Call Report's loan types; RC-N comes from the delinquency history (commercial and mortgage
// loans 90+ days go nonaccrual, consumer stay accruing until charge-off); RC-E from the deposit accounts;
// RI from average balances at their own rates, with fees and expenses at a community bank's ratios.
// Securities are sized so the balance sheet carries about 9.4% equity; the bank elects the community bank
// leverage ratio (8% from 1 July 2026), so RC-R needs no risk-weighted assets. Three GL accounts are left
// unmapped, the filing's one blocking edit. Nothing here is any real institution's data.
import type { GeneratedTenant } from './generate.ts';
import { FFIEC_051, FFIEC_051_EDITION } from './ffiec051.ts';

export const FFIEC_QUARTERS = [
  { end: '2025-09-30', label: 'Q3 2025', ytdMonths: 9 },
  { end: '2025-12-31', label: 'Q4 2025', ytdMonths: 12 },
  { end: '2026-03-31', label: 'Q1 2026', ytdMonths: 3 },
  { end: '2026-06-30', label: 'Q2 2026', ytdMonths: 6 },
  { end: '2026-09-30', label: 'Q3 2026', ytdMonths: 9 },
] as const;
/** The bank pays out 35% of earnings as common dividends. */
const DIVIDEND_PAYOUT = 0.35;

/** Due 30 days after quarter end through the FFIEC Central Data Repository (CDR); 35 only with more than one foreign office. */
export const FFIEC_FILING = { form: 'FFIEC 051', quarter: 'Q3 2026', periodEnd: '2026-09-30', dueDate: '2026-10-30', priorQuarter: 'Q2 2026', edition: FFIEC_051_EDITION, filedIn: 'the FFIEC Central Data Repository (CDR)', preparer: 'Elena Ortiz, Chief Financial Officer' };

const UNMAPPED_GL: [string, string, number, string, string, string, string][] = [
  ['1295', 'Suspense, wire clearing', 14_850, '2026-09-03', '2026-10-21', 'Other assets', 'Outgoing wires awaiting confirmation; should clear or be mapped before filing.'],
  ['1680', 'Prepaid FDIC assessment true-up', 7_300, '2026-08-14', '2026-09-30', 'Other assets', 'Assessment true-up booked in August; RC line not chosen yet.'],
  ['2455', 'Accrued, card program settlement', 4_940, '2026-09-24', '2026-10-23', 'Other liabilities', 'New card program settlement account; mapping not set.'],
];

/** Our categories on RC-C: [category, share, MDRM]. */
const LOAN_TYPES: [string, number, string][] = [
  ['Commercial Real Estate', 0.18, 'RCONF159'],
  ['Commercial Real Estate', 0.22, 'RCON1460'],
  ['Commercial Real Estate', 0.15, 'RCONF160'],
  ['Commercial Real Estate', 0.45, 'RCONF161'],
  ['Mortgage', 0.85, 'RCON5367'],
  ['Mortgage', 0.15, 'RCON1797'],
  ['Commercial & Industrial', 1, 'RCON1766'],
  ['Auto', 1, 'RCONK137'],
  ['Consumer', 0.3, 'RCONB538'],
  ['Consumer', 0.7, 'RCONK207'],
];
const NONACCRUAL_CATS = new Set(['Commercial Real Estate', 'Commercial & Industrial', 'Mortgage']);
const PAST_DUE_30_89 = new Set(['30–59 days', '60–89 days']);
const PAST_DUE_90 = new Set(['90–179 days', '180–359 days', '360+ days']);

const r0 = (n: number) => Math.round(n);

/** A whole-dollar amount split by weights so the parts add back to it exactly. */
function split(total: number, weights: number[]) {
  const sum = weights.reduce((a, b) => a + b, 0) || 1;
  const parts = weights.map((w) => Math.floor((total * w) / sum));
  parts[0]! += total - parts.reduce((a, b) => a + b, 0);
  return parts;
}

export function generateFfiecCallReport(t: GeneratedTenant) {
  const histLoan = t.histLoan as [string, number, string, number, number, number, number, number, number][];
  const histDeposit = t.histDeposit as [string, number, string, number, number][];
  const histDq = t.histDq as [string, number, string, number, number, string, number, number][];
  const loans = t.loans as [number, number, number, number, string, number, string, string | null, string | null, number, number, number, number][];
  const deposits = t.deposits as [number, number, number, string, string, string | null, string | null, number, number][];
  const parties = (t.parties as unknown[][]).length;

  const sumBy = <R>(rows: R[], key: (r: R) => string, val: (r: R) => number) => {
    const m = new Map<string, number>();
    for (const r of rows) m.set(key(r), (m.get(key(r)) ?? 0) + val(r));
    return m;
  };
  const rateOf = <R>(rows: R[], cat: (r: R) => string, bal: (r: R) => number, rate: (r: R) => number) => {
    const m = new Map<string, [number, number]>();
    for (const r of rows) {
      const a = m.get(cat(r)) ?? [0, 0];
      a[0] += bal(r) * rate(r);
      a[1] += bal(r);
      m.set(cat(r), a);
    }
    return new Map([...m].map(([k, [w, b]]) => [k, b ? w / b / 100 : 0]));
  };
  const loanRate = rateOf(loans.filter((l) => !l[7] && !l[8]), (l) => l[4], (l) => l[10], (l) => l[11]);
  const depRate = rateOf(deposits.filter((d) => !d[5]), (d) => d[3], (d) => d[7], (d) => d[8]);
  // Time deposits over $250,000, and uninsured balances above $250,000 per depositor, from today's accounts.
  const cds = deposits.filter((d) => !d[5] && /certific/i.test(d[3]));
  const jumboShare = cds.reduce((s, d) => s + (d[7] > 250_000 ? d[7] : 0), 0) / (cds.reduce((s, d) => s + d[7], 0) || 1);
  const byParty = sumBy(deposits.filter((d) => !d[5]), (d) => String(d[1]), (d) => d[7]);
  const allDeposits = deposits.filter((d) => !d[5]).reduce((s, d) => s + d[7], 0);
  // The retail book alone is almost fully insured; business operating accounts take a commercial bank's
  // uninsured share to about 28%, typical for its size.
  const uninsuredShare = Math.max(0.28, [...byParty.values()].reduce((s, b) => s + Math.max(0, b - 250_000), 0) / (allDeposits || 1));
  const months = [...new Set(histLoan.map((h) => h[0]))].sort();
  const monthsOfYear = (end: string) => months.filter((me) => me.startsWith(end.slice(0, 4)) && me <= end);
  const quarterMonths = (end: string) => months.filter((me) => me <= end).slice(-3);
  const loansAt = (me: string) => sumBy(histLoan.filter((h) => h[0] === me), (h) => h[2], (h) => h[4]);
  const depsAt = (me: string) => sumBy(histDeposit.filter((h) => h[0] === me), (h) => h[2], (h) => h[3]);
  const total = (m: Map<string, number>) => [...m.values()].reduce((a, b) => a + b, 0);

  const results: { values: Map<string, number>; text: Map<string, string> }[] = [];
  const equityAt = new Map<string, number>();
  // Equity rolls forward from the first quarter: earnings, less dividends, plus the change in AOCI.
  let carried: { equity: number; niYtd: number; aoci: number; year: string } | null = null;
  const aclAt = new Map<string, number>();
  FFIEC_QUARTERS.forEach((q, i) => {
    const v = new Map<string, number>();
    const text = new Map<string, string>();
    const set = (code: string, n: number) => v.set(code, r0(n));
    const get = (code: string) => v.get(code) ?? 0;
    const add = (codes: string[]) => codes.reduce((s, c) => s + get(c), 0);
    const m = q.ytdMonths / 12;
    const ytd = monthsOfYear(q.end);

    // ---- RC-C loans by type ----
    const bal = loansAt(q.end);
    for (const cat of new Set(LOAN_TYPES.map((x) => x[0]))) {
      const types = LOAN_TYPES.filter((x) => x[0] === cat);
      split(r0(bal.get(cat) ?? 0), types.map((x) => x[1])).forEach((amt, k) => set(types[k]![2], amt));
    }
    set('RCON2122', add(LOAN_TYPES.map((x) => x[2])));
    set('RCONB528', get('RCON2122'));

    // ---- RC-N past due and nonaccrual, from the month-end delinquency history ----
    const dq = histDq.filter((h) => h[0] === q.end);
    set('RCON1406', dq.filter((h) => PAST_DUE_30_89.has(h[5])).reduce((s, h) => s + h[6], 0));
    set('RCON1407', dq.filter((h) => PAST_DUE_90.has(h[5]) && !NONACCRUAL_CATS.has(h[2])).reduce((s, h) => s + h[6], 0));
    // Nonaccrual also holds commercial real estate loans whose collection is in doubt though they aren't
    // 90 days late; two impaired CRE loans moved there in the third quarter.
    const impaired = (bal.get('Commercial Real Estate') ?? 0) * [0.0034, 0.0036, 0.0035, 0.0037, 0.0105][i]!;
    set('RCON1403', dq.filter((h) => PAST_DUE_90.has(h[5]) && NONACCRUAL_CATS.has(h[2])).reduce((s, h) => s + h[6], 0) + impaired);

    // ---- RI-B charge-offs, recoveries and the allowance ----
    const avgLoans = ytd.reduce((s, me) => s + total(loansAt(me)), 0) / (ytd.length || 1);
    // Net charge-offs of about 0.30% a year, higher late in 2025.
    const nco = avgLoans * [0.0034, 0.0036, 0.0027, 0.0029, 0.003][i]! * m;
    set('RIAD4635', nco / 0.82);
    set('RIAD4605', get('RIAD4635') * 0.18);
    // An allowance of about 1.15% of loans, a little more as nonaccrual rises.
    set('RCON3123', get('RCON2122') * 0.0112 + get('RCON1403') * 0.08);
    aclAt.set(q.end, get('RCON3123'));
    const yearEnd = `${Number(q.end.slice(0, 4)) - 1}-12-31`;
    set('RIADB522', aclAt.get(yearEnd) ?? get('RCON3123') * 0.985);
    set('RIADJH88', get('RCON3123') - get('RIADB522') - get('RIAD4605') + get('RIAD4635'));
    set('RIAD3123', get('RCON3123'));
    set('RIADJJ33', get('RIADJH88'));
    set('RCONB529', get('RCONB528') - get('RCON3123'));

    // ---- RC-E deposits ----
    const dep = depsAt(q.end);
    const depBy = (re: RegExp) => [...dep].filter(([c]) => re.test(c)).reduce((s, [, b]) => s + b, 0);
    set('RCON2215', depBy(/checking/i));
    set('RCON6810', depBy(/money market/i));
    set('RCON0352', depBy(/^savings/i));
    const time = depBy(/certific/i);
    set('RCONJ474', time * jumboShare);
    set('RCONJ473', time - get('RCONJ474'));
    // Brokered certificates, a growing slice of time deposits: wholesale funding the CFO watches.
    set('RCON2365', time * [0.07, 0.072, 0.075, 0.08, 0.085][i]!);
    set('RCON2385', get('RCON6810') + get('RCON0352') + get('RCONJ473') + get('RCONJ474'));
    set('RCON2200E', get('RCON2215') + get('RCON2385'));
    set('RCON2200', get('RCON2200E'));
    // Uninsured deposits rose in the third quarter as two commercial depositors moved operating balances in.
    set('RCON5597', get('RCON2200') * uninsuredShare * [0.9, 0.92, 0.93, 0.86, 1][i]!);

    // ---- RC balance sheet: securities sized so equity is about 9.4% of assets ----
    const deps = get('RCON2200');
    set('RCON0081', deps * 0.016);
    set('RCON0071', deps * 0.046);
    set('RCON2145', deps * 0.011);
    // Goodwill and a core deposit intangible from a 2021 branch purchase; the intangible amortizes.
    set('RCON3163', 1_600_000);
    set('RCON0426', 450_000 - 30_000 * i);
    set('RCON2160', deps * 0.012 - get('RCON3163') - get('RCON0426'));
    set('RCON3190', [30_000_000, 29_000_000, 28_500_000, 27_000_000, 25_000_000][i]!);
    set('RCON2930', deps * 0.008);
    const eq = [0.0925, 0.093, 0.0935, 0.094, 0.0945][i]!;
    const assets = (get('RCON2200') + get('RCON3190') + get('RCON2930')) / (1 - eq);
    const securities = assets - add(['RCON0081', 'RCON0071', 'RCONB529', 'RCON2145', 'RCON3163', 'RCON0426', 'RCON2160']);
    set('RCON1754', securities * 0.2);
    set('RCON1773', securities - get('RCON1754'));
    set('RCON1754B', get('RCON1754'));
    set('RCON1773B', get('RCON1773'));
    set('RCON1771', get('RCON1754') * 0.95);
    // Available-for-sale securities carry an unrealized loss of about 6%, after rate rises: an AOCI story.
    set('RCON1772', get('RCON1773') / [0.935, 0.938, 0.94, 0.942, 0.944][i]!);
    set('RCON0416', securities * 0.35);
    set('RCON2170', add(['RCON0081', 'RCON0071', 'RCON1754', 'RCON1773', 'RCONB529', 'RCON2145', 'RCON3163', 'RCON0426', 'RCON2160']));
    set('RCONB530', -(get('RCON1772') - get('RCON1773')) * 0.79);
    // Net income closes each year to date to its return on assets, about 1% for a well-run community bank.
    const netIncome = get('RCON2170') * [0.0094, 0.0097, 0.0103, 0.0101, 0.0099][i]! * m;
    const year = q.end.slice(0, 4);
    if (carried) {
      // The quarter's own earnings: year to date less the last quarter's in the same year.
      const earned = netIncome - (carried.year === year ? carried.niYtd : 0);
      const equity = carried.equity + earned * (1 - DIVIDEND_PAYOUT) + (get('RCONB530') - carried.aoci);
      // Other liabilities take up the difference, so the balance sheet still balances.
      set('RCON2930', get('RCON2170') - get('RCON2200') - get('RCON3190') - equity);
    }
    set('RCON2948', add(['RCON2200', 'RCON3190', 'RCON2930']));
    set('RCON3210', get('RCON2170') - get('RCON2948'));
    carried = { equity: get('RCON3210'), niYtd: netIncome, aoci: get('RCONB530'), year };
    set('RCON3230', 5_000_000);
    set('RCON3839', 45_000_000);
    set('RCON3632', get('RCON3210') - get('RCON3230') - get('RCON3839') - get('RCONB530'));
    set('RCON3300', get('RCON2948') + get('RCON3210'));
    equityAt.set(q.end, get('RCON3210'));

    // ---- RC-K quarterly averages ----
    const qm = quarterMonths(q.end);
    set('RCON3360', qm.reduce((s, me) => s + total(loansAt(me)), 0) / (qm.length || 1));
    set('RCON3368', get('RCON2170') * 0.996);

    // ---- RI income statement, year to date ----
    const avgLoanBy = sumBy(histLoan.filter((h) => ytd.includes(h[0])), (h) => h[2], (h) => h[4] / (ytd.length || 1));
    const avgDepBy = sumBy(histDeposit.filter((h) => ytd.includes(h[0])), (h) => h[2], (h) => h[3] / (ytd.length || 1));
    let loanInterest = 0;
    for (const [cat, avg] of avgLoanBy) loanInterest += avg * (loanRate.get(cat) ?? 0.07) * m;
    set('RIAD4010', loanInterest);
    set('RIAD4115', get('RCON0071') * 0.043 * m);
    set('RIADB488', securities * 0.0305 * m);
    set('RIAD4107', add(['RIAD4010', 'RIAD4115', 'RIADB488']));
    const depInterest = (re: RegExp) => [...avgDepBy].filter(([c]) => re.test(c)).reduce((s, [c, avg]) => s + avg * (depRate.get(c) ?? 0.01) * m, 0);
    set('RIAD4508', depInterest(/checking/i));
    set('RIAD0093', depInterest(/money market|^savings/i));
    const timeInterest = depInterest(/certific/i);
    set('RIADHK04', timeInterest * jumboShare);
    set('RIADHK03', timeInterest - get('RIADHK04'));
    set('RIAD4180', get('RCON3190') * 0.046 * m);
    set('RIAD4073', add(['RIAD4508', 'RIAD0093', 'RIADHK03', 'RIADHK04', 'RIAD4180']));
    set('RIAD4074', get('RIAD4107') - get('RIAD4073'));
    // Noninterest income: deposit and card fees, a trust department, brokerage, annuity and insurance
    // commissions, and mortgage banking (servicing fees and gains on loans sold, which rose as mortgage
    // rates eased in 2026). No trading revenue: that's a big-bank business.
    const wealth = [1, 1.015, 1.03, 1.045, 1.06][i]!;
    set('RIAD4070', 1_050_000 * wealth * m);
    set('RIAD4080', parties * 3.1 * [1.03, 1.02, 1.01, 1, 0.99][i]! * q.ytdMonths);
    set('RIADC886', 320_000 * wealth * m);
    set('RIADC887', 180_000 * [0.95, 0.97, 1, 1.02, 1.04][i]! * m);
    set('RIADC387', 220_000 * [0.97, 0.98, 1, 1.01, 1.03][i]! * m);
    set('RIADB492', 400_000 * [1, 1.01, 1.02, 1.03, 1.04][i]! * m);
    set('RIAD5416', [700_000, 620_000, 850_000, 1_050_000, 1_100_000][i]! * m);
    set('RIADF555', parties * 4.4 * [0.94, 0.96, 0.98, 1, 1.02][i]! * q.ytdMonths);
    set('RIADB497', get('RCON2170') * 0.001 * m);
    set('RIAD4079', add(['RIAD4070', 'RIAD4080', 'RIADC886', 'RIADC887', 'RIADC387', 'RIADB492', 'RIAD5416', 'RIADF555', 'RIADB497']));
    set('RIAD4340', netIncome);
    set('RIAD4302', netIncome * (0.21 / 0.79));
    set('RIAD4301', get('RIAD4340') + get('RIAD4302'));
    const opex = get('RIAD4074') - get('RIADJJ33') + get('RIAD4079') - get('RIAD4301');
    split(r0(opex), [0.52, 0.13, 0.35]).forEach((amt, k) => set(['RIAD4135', 'RIAD4217', 'RIAD4092'][k]!, amt));
    set('RIAD4093', add(['RIAD4135', 'RIAD4217', 'RIAD4092']));

    // ---- RI-A changes in equity ----
    set('RIAD3217', equityAt.get(yearEnd) ?? get('RCON3210') * 0.965);
    set('RIAD4340A', get('RIAD4340'));
    set('RIAD4460', get('RIAD4340') * DIVIDEND_PAYOUT);
    set('RIADB511', get('RCON3210') - get('RIAD3217') - get('RIAD4340A') + get('RIAD4460'));
    set('RIAD3210', get('RCON3210'));

    // ---- RC-R Part I: the community bank leverage ratio ----
    text.set('RCONLE74', 'Yes');
    // AOCI opt-out: unrealized losses on available-for-sale securities don't reduce regulatory capital.
    // Goodwill and other intangibles come out of capital (the purchase was an asset deal, so no deferred tax offsets them).
    set('RCONP841', get('RCON3163'));
    set('RCONP842', get('RCON0426'));
    set('RCON8274', get('RCON3210') - get('RCONB530') - get('RCONP841') - get('RCONP842'));
    set('RCONP742', get('RCON8274'));
    set('RCONA224', get('RCON3368'));
    v.set('RCON7204', Math.round((get('RCON8274') / get('RCONA224')) * 10_000) / 100);
    results.push({ values: v, text });
  });

  // ---- lines, values, the GL and the checks ----
  const source = (code: string, schedule: string, kind: string) => (kind === 'total' ? 'Computed from the lines above' : schedule === 'RC-C' || schedule === 'RC-N' ? 'Core loan system' : schedule === 'RC-E' || schedule === 'RC-O' ? 'Core deposit system' : schedule === 'RC-B' ? 'Investment accounting' : schedule === 'RC-R' ? 'Capital worksheet' : code.startsWith('RIAD') || schedule === 'RC' ? 'General ledger' : 'General ledger');
  const lineRows = FFIEC_051.map(([code, schedule, scheduleName, section, order, name, kind, formula], k) => [code, schedule, scheduleName, section, k * 10 + order, name, kind, formula, source(code, schedule, kind)]);
  const valueRows: unknown[][] = [];
  FFIEC_QUARTERS.forEach((q, i) => {
    for (const [code] of FFIEC_051) valueRows.push([code, q.end, results[i]!.values.has(code) ? results[i]!.values.get(code)! : null, results[i]!.text.get(code) ?? null]);
  });
  const cur = results.at(-1)!.values;
  const pri = results.at(-2)!.values;
  const g = (code: string) => cur.get(code) ?? 0;
  const p = (code: string) => pri.get(code) ?? 0;
  const money = (n: number) => `$${Math.round(n).toLocaleString('en-US')}`;

  // GL: each input line on RC and RI has its own account; three accounts have no line yet.
  const glRows: unknown[][] = [];
  let n = 1000;
  for (const [code, schedule, , , , name, kind] of FFIEC_051) {
    if (kind !== 'input' || !['RC', 'RI'].includes(schedule) || !cur.has(code)) continue;
    n += 10;
    glRows.push([String(code.startsWith('RIAD') ? n + 3000 : n), name.slice(0, 80), g(code), p(code), code, '2004-01-01', '2026-09-30', null, null]);
  }
  for (const [gl, name, amount, opened, last, likely, note] of UNMAPPED_GL) glRows.push([gl, name, amount, 0, null, opened, last, likely, note]);
  const unmapped = UNMAPPED_GL.reduce((s, x) => s + x[2], 0);

  // Intraseries: balance-sheet and loan lines that moved more than 10% and $1,000,000 need an explanation.
  const moved = FFIEC_051.filter(([code, schedule, , , , , kind]) => ['RC', 'RC-C', 'RC-E'].includes(schedule) && kind === 'input' && Math.abs(g(code) - p(code)) >= 1_000_000 && Math.abs(g(code) - p(code)) / Math.max(1, Math.abs(p(code))) > 0.1).map((l) => l[0]);
  const explained = new Map<string, string>([['RCON3190', `Repaid ${money(p('RCON3190') - g('RCON3190'))} of FHLB advances at maturity in August from deposit growth.`]]);
  const nonaccrualMove = p('RCON1403') ? ((g('RCON1403') - p('RCON1403')) / p('RCON1403')) * 100 : 0;
  const uninsuredMove = p('RCON5597') ? ((g('RCON5597') - p('RCON5597')) / p('RCON5597')) * 100 : 0;
  const nonOwnerCre = g('RCONF159') + g('RCON1460') + g('RCONF161');
  const capitalBase = g('RCON8274') + g('RCON3123');
  const cre = (nonOwnerCre / capitalBase) * 100;
  // Every line that needs an explanation: large balance-sheet moves, and the items whose quality edit failed.
  const needs = [...new Set([...moved, ...(Math.abs(uninsuredMove) >= 15 ? ['RCON5597'] : []), ...(Math.abs(nonaccrualMove) >= 25 ? ['RCON1403'] : [])])];
  const openMoved = moved.filter((c) => !explained.has(c));
  const openQuality = needs.filter((c) => !moved.includes(c) && !explained.has(c));
  const checks: [string, string, string, string, string | null, string | null][] = [
    ['RC: total assets equal the asset items', 'Pass', `RCON2170 is ${money(g('RCON2170'))}.`, 'Error', 'V-RC-01', 'RCON2170'],
    ['RC: total liabilities and equity equal total assets', 'Pass', `RCON3300 and RCON2170 are both ${money(g('RCON2170'))}.`, 'Error', 'V-RC-02', 'RCON3300,RCON2170'],
    ['RC-C: total loans equal RC loans held for investment', 'Pass', `RCON2122 and RCONB528 are both ${money(g('RCON2122'))}.`, 'Error', 'V-RCC-01', 'RCON2122,RCONB528'],
    ['RI: net interest income equals interest income less interest expense', 'Pass', `RIAD4074 ${money(g('RIAD4074'))} year to date.`, 'Error', 'V-RI-01', 'RIAD4074,RIAD4107,RIAD4073'],
    ['RI-A: ending equity equals RC total equity', 'Pass', `RIAD3210 and RCON3210 are both ${money(g('RCON3210'))}.`, 'Error', 'V-RIA-01', 'RIAD3210,RCON3210'],
    ['RI-B: ending allowance equals RC allowance', 'Pass', `RIAD3123 and RCON3123 are both ${money(g('RCON3123'))}.`, 'Error', 'V-RIB-01', 'RIAD3123,RCON3123'],
    ['RI-B: charge-offs don’t exceed loans', 'Pass', `Charge-offs YTD ${money(g('RIAD4635'))} against loans of ${money(g('RCON2122'))}.`, 'Error', 'V-RIB-02', 'RIAD4635,RCON2122'],
    ['RC-N: past due and nonaccrual within RC-C balances', 'Pass', `${money(g('RCON1406') + g('RCON1407') + g('RCON1403'))} past due or nonaccrual, against loans of ${money(g('RCON2122'))}.`, 'Error', 'V-RCN-01', 'RCON1406,RCON1407,RCON1403'],
    ['RC-E: transaction and nontransaction add up to total deposits', 'Pass', `RCON2215 ${money(g('RCON2215'))} plus RCON2385 ${money(g('RCON2385'))}.`, 'Error', 'V-RCE-01', 'RCON2215,RCON2385,RCON2200'],
    ['RC-R: the leverage ratio meets the community bank leverage ratio', 'Pass', `${g('RCON7204').toFixed(2)}% against the 8% required from July 1, 2026.`, 'Error', 'V-RCR-01', 'RCON7204,RCONLE74'],
    ['GL accounts categorized', 'Fail', `${UNMAPPED_GL.length} uncategorized GL accounts, totalling ${money(unmapped)}.`, 'Error', null, null],
    ['Nonaccrual loans moved less than 25% from Q2 2026', Math.abs(nonaccrualMove) < 25 ? 'Pass' : 'Fail', `Nonaccrual loans (RCON1403) are ${money(g('RCON1403'))}, ${nonaccrualMove >= 0 ? 'up' : 'down'} ${Math.abs(nonaccrualMove).toFixed(1)}% from ${money(p('RCON1403'))}${Math.abs(nonaccrualMove) >= 25 ? ', so they need an explanation' : ''}.`, 'Warning', 'Q-RCN-01', 'RCON1403'],
    ['Uninsured deposits moved less than 15% from Q2 2026', Math.abs(uninsuredMove) < 15 ? 'Pass' : 'Fail', `Uninsured deposits (RCON5597) are ${money(g('RCON5597'))}, ${uninsuredMove >= 0 ? 'up' : 'down'} ${Math.abs(uninsuredMove).toFixed(1)}% from ${money(p('RCON5597'))}${Math.abs(uninsuredMove) >= 15 ? ', so they need an explanation' : ''}.`, 'Warning', 'Q-RCO-01', 'RCON5597'],
    // Balance-sheet moves only: items flagged by a quality edit are counted there, not twice.
    ['Large balance changes are explained', openMoved.length ? 'Fail' : 'Pass', `${openMoved.length ? `${openMoved.length} of ${moved.length} balance-sheet lines that moved more than 10% and $1M still need an explanation: ${openMoved.join(', ')}.` : `Every balance-sheet line that moved more than 10% and $1M has an explanation${moved.length ? '' : ' (none did)'}.`}${openQuality.length ? ` ${openQuality.join(' and ')} also ${openQuality.length === 1 ? 'needs one for its quality edit' : 'need one for their quality edits'}.` : ''}`, 'Warning', null, needs.join(',')],
    ['CRE concentration under 300% of capital', cre < 300 ? 'Pass' : 'Fail', `Non-owner-occupied commercial real estate ${money(nonOwnerCre)} is ${cre.toFixed(0)}% of Tier 1 capital plus the allowance (interagency guidance: 300%).`, 'Warning', null, 'RCONF159,RCON1460,RCONF161,RCON8274,RCON3123'],
  ];
  const explanations = needs.map((code) => [code, FFIEC_FILING.periodEnd, explained.get(code) ?? null, explained.has(code) ? 'Written' : 'Needed', explained.has(code) ? 'Elena Ortiz' : null]);
  const form = [['FFIEC 051', FFIEC_FILING.edition, FFIEC_FILING.filedIn, FFIEC_FILING.quarter, FFIEC_FILING.dueDate, FFIEC_FILING.preparer]];
  return { lines: lineRows, values: valueRows, gl: glRows, checks, explanations, form };
}
