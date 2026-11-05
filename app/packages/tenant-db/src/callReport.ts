// The NCUA 5300 Call Report for the credit union tenant: every line of the form for Q2 and Q3 2026,
// derived from the same loans, shares, members and month-end history every other page reads, so the
// call report ties to Home, the reports and the agents. The general ledger behind it maps each GL
// account to its 5300 line; three accounts are left unmapped, which is the filing's one blocking edit.
// Ratios are typical of a $1.9B federal credit union; nothing here is any real institution's data.
import type { GeneratedTenant } from './generate.ts';
import { NCUA_5300, NCUA_5300_EDITION } from './ncua5300.ts';

export const CR_QUARTERS = [
  { end: '2026-06-30', label: 'Q2 2026', ytdMonths: 6 },
  { end: '2026-09-30', label: 'Q3 2026', ytdMonths: 9 },
] as const;

/** The quarter being prepared. Due the 30th of the month after quarter end, filed in CUOnline. */
export const CR_FILING = { quarter: 'Q3 2026', periodEnd: '2026-09-30', dueDate: '2026-10-30', priorQuarter: 'Q2 2026', edition: NCUA_5300_EDITION, preparer: 'Priya Shah, BI Manager' };

/** Accounts the GL can't place yet; together they are $18,400 (the "GL accounts categorized" check). */
const UNMAPPED_GL: [string, string, number, string, string, string, string][] = [
  ['1188', 'Due from CUSO, card program', 2_430, '2026-08-19', '2026-10-17', 'Other assets', 'Opened in August for the new card program; no 5300 line chosen yet.'],
  ['1795', 'Prepaid software licences', 9_850, '2026-07-02', '2026-10-01', 'Prepaid and other assets', 'Annual licence prepaid in July and amortised monthly; mapping not set.'],
  ['2310', 'Suspense, card settlement', 6_120, '2026-09-28', '2026-10-24', 'Accrued liabilities', 'Settlement timing differences; should clear or be mapped before filing.'],
];

/** Our loan categories on the 5300's loan types: [category, share of it, count code, amount code, delinquency row, charge-off, recovery]. */
const LOAN_TYPES: [string, number, string, string, string, string, string][] = [
  ['Credit Card', 1, '993', '396', 'Unsecured Credit Card Loans', '680', '681'],
  ['Personal', 1, '994', '397', 'All Other Unsecured Loans/Lines of Credit', 'CH0007', 'CH0008'],
  ['Auto', 0.38, '958', '385', 'New Vehicle Loans', '550C1', '551C1'],
  ['Auto', 0.62, '968', '370', 'Used Vehicle Loans', '550C2', '551C2'],
  ['Mortgage', 1, '959A', '703A', 'Secured by 1st Lien on a single 1- to 4-Family Residential Property', 'CH0017', 'CH0018'],
  ['HELOC', 1, '960A', '386A', 'Secured by Junior Lien on a single 1- to 4-Family Residential Property', 'CH0019', 'CH0020'],
  ['Business', 0.6, '900K4', '718A5', 'Secured by Owner Occupied, Non-Farm, Non-Residential Property', 'CH0029', 'CH0030'],
  ['Business', 0.4, '900P', '400P', 'Commercial and Industrial Loans', 'CH0035', 'CH0036'],
];
const COMMERCIAL = new Set(['900K4', '900P']);

/** The 5300's aging columns and the month-end delinquency status each one reads. */
const BUCKETS: [string, string][] = [[' - 30 - 59 days', '30–59 days'], [' - 60 - 89 days', '60–89 days'], [' - 90 - 179 days', '90–179 days'], [' - 180 - 359 days', '180–359 days'], [' - >=360 days', '360+ days']];

const r0 = (n: number) => Math.round(n);
const pct = (n: number) => Math.round(n * 100) / 100;

/** Splits a whole-dollar amount by weights so the parts add back to it exactly. */
function split(total: number, weights: number[]) {
  const sum = weights.reduce((a, b) => a + b, 0) || 1;
  const parts = weights.map((w) => Math.floor((total * w) / sum));
  parts[0]! += total - parts.reduce((a, b) => a + b, 0);
  return parts;
}

interface Quarter {
  values: Map<string, number>;
  text: Map<string, string>;
  /** GL accounts: [number, name, line code] with their balance for this quarter. */
  gl: { gl: string; name: string; line: string; amount: number }[];
}

export function generateCallReport(t: GeneratedTenant) {
  const dqCode = new Map<string, string>();
  for (const [code, schedule, , section, , name] of NCUA_5300) if (schedule === 'A' && section.startsWith('Section 2 - Delinquent Loans & Leases:') && !section.endsWith('Total')) dqCode.set(name, code);
  const histLoan = t.histLoan as [string, number, string, number, number, number, number, number, number][];
  const histDeposit = t.histDeposit as [string, number, string, number, number][];
  const histParty = t.histParty as [string, number, number, number][];
  const loans = t.loans as [number, number, number, number, string, number, string, string | null, string | null, number, number, number, number][];
  const histDq = t.histDq as [string, number, string, number, number, string, number, number][];
  const deposits = t.deposits as [number, number, number, string, string, string | null, string | null, number, number][];

  // Balance-weighted rates by category, from the accounts themselves.
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
  const shareRate = rateOf(deposits.filter((d) => !d[5]), (d) => d[3], (d) => d[7], (d) => d[8]);

  const sumBy = <R>(rows: R[], key: (r: R) => string, val: (r: R) => number) => {
    const m = new Map<string, number>();
    for (const r of rows) m.set(key(r), (m.get(key(r)) ?? 0) + val(r));
    return m;
  };
  const monthsTo = (end: string) => [...new Set(histLoan.map((h) => h[0]))].filter((me) => me.startsWith('2026') && me <= end).sort();

  const build = (q: (typeof CR_QUARTERS)[number], i: number): Quarter => {
    const v = new Map<string, number>();
    const text = new Map<string, string>();
    const gl: Quarter['gl'] = [];
    const set = (code: string, n: number) => v.set(code, r0(n));
    const get = (code: string) => v.get(code) ?? 0;
    const add = (codes: string[]) => codes.reduce((s, c) => s + get(c), 0);
    const atEnd = histLoan.filter((h) => h[0] === q.end);
    const bal = sumBy(atEnd, (h) => h[2], (h) => h[4]);
    const dq60 = sumBy(atEnd, (h) => h[2], (h) => h[5]);
    const cnt = sumBy(atEnd, (h) => h[2], (h) => h[6]);
    const ytd = monthsTo(q.end);
    const ytdRows = histLoan.filter((h) => ytd.includes(h[0]));
    const avgLoan = sumBy(ytdRows, (h) => h[2], (h) => h[4] / ytd.length);
    const shares = sumBy(histDeposit.filter((h) => h[0] === q.end), (h) => h[2], (h) => h[3]);
    const avgShare = sumBy(histDeposit.filter((h) => ytd.includes(h[0])), (h) => h[2], (h) => h[3] / ytd.length);
    const members = histParty.filter((h) => h[0] === q.end).reduce((s, h) => s + h[2], 0);
    const m = q.ytdMonths / 12;

    // ---- Schedule A: loans, delinquency and charge-offs by loan type ----
    const coRaw = sumBy(loans.filter((l) => l[8] && l[8] >= '2026-01-01' && l[8] <= q.end), (l) => l[4], (l) => l[9] * 0.55);
    // Net charge-offs run about 0.62% of loans a year; the mix follows the book's own charge-offs.
    const coTarget = [...avgLoan.values()].reduce((a, b) => a + b, 0) * 0.0062 * m;
    const coMix = [...bal.keys()].map((c) => (coRaw.get(c) ?? 0) + (dq60.get(c) ?? 0) * 0.15);
    const coByCat = new Map([...bal.keys()].map((c, k) => [c, (coTarget * coMix[k]!) / (coMix.reduce((a, b) => a + b, 0) || 1)]));
    for (const [cat, share, countCode, amountCode, row, coCode, recCode] of LOAN_TYPES) {
      const amount = r0((bal.get(cat) ?? 0) * share);
      const count = r0((cnt.get(cat) ?? 0) * share);
      set(countCode, count);
      set(amountCode, amount);
      gl.push({ gl: '', name: `Loans, ${row.replace(/ Loans\/Lines of Credit| Loans$/g, '').toLowerCase()}`, line: amountCode, amount });
      // Each aging column is the quarter-end delinquency history, so the 5300 and the delinquency report agree.
      const at = (status: string) => histDq.filter((h) => h[0] === q.end && h[2] === cat && h[5] === status);
      let d60 = 0;
      let n60 = 0;
      for (const [suffix, status] of BUCKETS) {
        const hs = at(status);
        const amt = r0(hs.reduce((s2, h) => s2 + h[6], 0) * share);
        set(dqCode.get(`${row}${suffix}`)!, amt);
        if (status !== '30–59 days') {
          d60 += amt;
          n60 += hs.reduce((s2, h) => s2 + h[7], 0) * share;
        }
      }
      set(dqCode.get(`${row} - Total Amount of Loans Delinquent 60+ Days`)!, d60);
      set(dqCode.get(`${row} - Total Number of Loans Delinquent 60+ Days`)!, n60);
      const co = (coByCat.get(cat) ?? 0) * share;
      set(coCode, co);
      set(recCode, co * 0.14);
    }
    // Every other loan type is reported as zero.
    for (const code of dqCode.values()) if (!v.has(code)) v.set(code, 0);
    for (const [code, schedule, , section, , , kind] of NCUA_5300) if (schedule === 'A' && kind === 'input' && !v.has(code) && (section.startsWith('Section 1') || section.startsWith('Section 3'))) v.set(code, 0);
    const types = LOAN_TYPES.map((x) => x);
    set('025A1', add(types.map((x) => x[2])));
    set('025B1', add(types.map((x) => x[3])));
    set('025A', get('025A1'));
    set('025B', get('025B1'));
    set('031A', ytdRows.reduce((s, h) => s + h[8], 0));
    set('031B', ytdRows.reduce((s, h) => s + h[7], 0));
    const bucketTotal = (suffix: string) => [...dqCode].filter(([n]) => n.endsWith(suffix)).reduce((s, [, c]) => s + get(c), 0);
    set('020B', bucketTotal(' - 30 - 59 days'));
    set('DL0141', bucketTotal(' - 60 - 89 days'));
    set('021B', bucketTotal(' - 90 - 179 days'));
    set('022B', bucketTotal(' - 180 - 359 days'));
    set('023B', bucketTotal(' - >=360 days'));
    set('041B', get('DL0141') + get('021B') + get('022B') + get('023B'));
    set('041A', bucketTotal(' - Total Number of Loans Delinquent 60+ Days'));
    const autoDq = (dq60.get('Auto') ?? 0);
    set('DL0142', 0);
    set('041E', autoDq * 0.58);
    set('DL0144', 0);
    const ninety = (codes: string[]) => codes.reduce((s, row) => s + get(dqCode.get(`${row} - 90 - 179 days`)!) + get(dqCode.get(`${row} - 180 - 359 days`)!) + get(dqCode.get(`${row} - >=360 days`)!), 0);
    set('DL0145', ninety(LOAN_TYPES.filter((x) => !COMMERCIAL.has(x[2])).map((x) => x[4])));
    set('DL0146', ninety(LOAN_TYPES.filter((x) => COMMERCIAL.has(x[2])).map((x) => x[4])));
    set('971', get('025B') * 0.0004);
    set('1000F', get('025B') * 0.0011);
    set('1001F', get('718A5') * 0.004);
    set('550', LOAN_TYPES.reduce((s, x) => s + get(x[5]), 0));
    set('551', LOAN_TYPES.reduce((s, x) => s + get(x[6]), 0));
    set('550F', 0);
    set('551F', 0);
    set('550E', get('550C1') * 0.6 + get('550C2') * 0.55);
    set('551E', get('551C1') * 0.6 + get('551C2') * 0.55);

    // ---- Shares and members ----
    const S = [...shares.values()].reduce((a, b) => a + b, 0);
    set('013', S);
    set('880', 0);
    set('018', S);
    for (const [cat, amount] of shares) gl.push({ gl: '', name: `Member shares, ${cat.toLowerCase()}`, line: '013', amount: r0(amount) });
    set('083', members);
    set('084', members * 6.2);
    set('065A4', S * 0.036);
    set('067A2', 0);
    set('068A', get('065A4') + get('067A2'));
    set('069A', S - get('068A'));

    // ---- Statement of Financial Condition: assets solved so the balance sheet balances ----
    const L = get('025B');
    const nwRatio = [0.1041, 0.1052][i]!;
    // A few balances move between quarters (the ones the variance check asks to explain).
    const timeDep = [0.0071, 0.0113][i]!;
    const borrow = [0.0221, 0.0118][i]!;
    const heldForSale = [0.0008, 0.0015][i]!;
    const fa = { AS0004: 0.0032, AS0005: 0.0004, '730B1': 0.0065, AS0003: [0.034, 0.029][i]!, '730B2': 0.0035, AS0007: timeDep, AS0008: 0, AS0055: 0.0008, AS0061: 0, AS0073: 0.016, '769A': 0.0004, '769B': 0.0006, AS0016: 0.0035, AS0022: 0, AS0023: 0.0001, AS0024: 0.0002, AS0025: 0.00005, '007': 0.0135, '008': 0.0022, '009D2': 0, '779': 0.0004, AS0032: 0, '009C': 0.0045 } as Record<string, number>;
    const liabF = 0.0055 + 0.0008 + 0.0002;
    // Total assets follow from shares and the funding mix; the AFS portfolio then closes the balance sheet.
    const A = S / (1 - liabF - borrow - nwRatio);
    for (const [code, f] of Object.entries(fa)) set(code, f * A);
    set('003', heldForSale * A);
    set('AS0048', L * 0.0118);
    set('719', 0);
    set('794', get('069A') * 0.01);
    set('009A', L * 0.0028);
    // AFS debt securities take what's left, so assets = liabilities + shares + equity to the dollar.
    const otherAssets = ['AS0022', 'AS0023', 'AS0024', 'AS0025', '007', '008', '794', '009D2', '779', 'AS0032', '009A', '009B', '009C'];
    set('730A', add(['AS0004', 'AS0005']));
    set('730B', add(['730B1', 'AS0003', '730B2']));
    set('AS0009', add(['730A', '730B', 'AS0007', 'AS0008']));
    set('AS0017', add(['769A', '769B', 'AS0016']));
    set('798A', add(['AS0022', 'AS0023', 'AS0024', 'AS0025']));
    set('AS0041', 0);
    set('AS0042', 0);
    set('825', A * 0.0055);
    set('820A', A * 0.0008);
    set('LI0003', A * 0.0002);
    set('860C', A * borrow);
    set('LI0069', add(['825', '820A', 'LI0003', '860C', '018']));
    set('658', A * 0.0045);
    for (const c of ['668', '658A', '996', '945A', '945C', '945B', '602', 'NW0004', '925A', '1004']) set(c, 0);
    set('997', r0(A * nwRatio));
    set('940', get('997') - get('658'));
    // Investments and OCI close the balance: AFS at fair value with a 2.15% unrealized loss.
    const beforeAfs = add(['AS0009', 'AS0055', 'AS0061', 'AS0073', 'AS0017', '003']) + L - get('AS0048') + add(otherAssets.filter((c) => c !== '009B'));
    const funding = get('LI0069') + get('940') + get('658');
    // assets = funding + OCI, with OCI = -2.15% of AFS and 009B = 0.12% of investments: solve for AFS.
    const afs = (funding - beforeAfs - get('AS0073') * 0.0012) / (1 + 0.0215 + 0.0012);
    set('AS0067', afs);
    set('EQ0009', -afs * 0.0215);
    set('AS0013', add(['AS0055', 'AS0061', 'AS0067', 'AS0073']) - get('AS0041'));
    set('009B', (get('AS0067') + get('AS0073')) * 0.0012);
    set('AS0036', add(otherAssets));
    set('010', add(['AS0009', 'AS0013', 'AS0017', '003', '025B']) - get('AS0048') - get('719') + add(['798A', '007', '008', '794', '009D2', '779', 'AS0032', '009A', '009B', '009C']));
    // Rounding lands in accrued liabilities, so the edit E0025 (014 = 010) holds to the dollar.
    const gap = get('010') - (get('LI0069') + add(['940', '658', '668', '658A', '996', '945A', '945B', '945C', 'EQ0009', '602']));
    set('825', get('825') + gap);
    set('LI0069', add(['825', '820A', 'LI0003', '860C', '018']));
    set('014', get('LI0069') + add(['940', '658', '668', '658A', '996', '945A', '945B', '945C', 'EQ0009', '602']));
    text.set('AS0010', 'Yes');

    // ---- Schedule B ----
    set('NV0081', get('AS0073'));
    set('801', get('AS0073') * 0.985);
    set('NV0084', get('AS0067'));
    set('NV0083', get('AS0067') / (1 - 0.0215));
    set('NV0004', get('AS0067') * 0.22);
    set('NV0024', get('AS0067') * 0.48);
    set('NV0036', get('AS0067') * 0.24);
    set('NV0072', get('AS0067') - get('NV0004') - get('NV0024') - get('NV0036'));
    set('NV0105', get('AS0061'));
    set('NV0109', get('AS0055'));
    set('NV0110', get('NV0105') + get('NV0109'));
    const inv = get('AS0013') + get('AS0007');
    const mat = split(inv, [0.21, 0.33, 0.26, 0.15, 0.05]);
    ['NV0153', 'NV0154', 'NV0155', 'NV0156', 'NV0157'].forEach((c, k) => set(c, mat[k]!));
    set('NV0158', inv);
    for (const c of ['784A', '788', 'NV0159', 'NV0160', 'NV0161', 'NV0162']) set(c, 0);

    // ---- Statement of Income and Expense, year to date ----
    let interest = 0;
    for (const [cat, avg] of avgLoan) interest += avg * (loanRate.get(cat) ?? 0.07) * m;
    set('110', interest);
    set('119', interest * 0.0015);
    set('120', (get('AS0013') + get('AS0017')) * 0.0305 * m);
    set('IS0005', (get('AS0003') + get('AS0007')) * 0.0435 * m);
    set('115', get('110') - get('119') + get('120') + get('IS0005'));
    let dividends = 0;
    for (const [cat, avg] of avgShare) dividends += avg * (shareRate.get(cat) ?? 0.01) * m;
    set('380', dividends);
    set('381', 0);
    set('340', get('860C') * 0.046 * m);
    set('350', add(['380', '381', '340']));
    set('IS0010', get('115') - get('350'));
    set('300', 0);
    const nco = get('550') - get('551');
    set('IS0011', nco * 1.1);
    set('IS0012', 0);
    set('IS0013', 0);
    set('IS0016', get('IS0011') * 0.005);
    set('IS0017', add(['IS0011', 'IS0012', 'IS0013', 'IS0016']));
    set('131', members * 7.4 * q.ytdMonths);
    set('IS0020', members * 4.1 * q.ytdMonths);
    for (const c of ['IS0046', 'IS0047', '421', '430', 'IS0030', '431']) set(c, 0);
    set('IS0029', get('031B') * 0.0011);
    set('440', members * 0.9 * q.ytdMonths);
    set('117', add(['131', 'IS0020', 'IS0046', 'IS0047', '421', '430', 'IS0029', 'IS0030', '431', '440']));
    const opex: [string, number][] = [['230', 0.0003], ['250', 0.0024], ['260', 0.0052], ['270', 0.0011], ['280', 0.0019], ['290', 0.0021], ['310', 0.0001], ['320', 0.0003], ['360', 0.0007]];
    for (const [c, f] of opex) set(c, A * f * m);
    // Compensation is the largest expense and closes to a return on assets of about 0.92%.
    const target = A * 0.0092 * m;
    set('210', get('IS0010') - get('IS0017') + get('117') - add(opex.map((x) => x[0])) - target);
    set('671', add(['210', ...opex.map((x) => x[0])]));
    set('661A', get('IS0010') - get('300') - get('IS0017') + get('117') - get('671'));

    // ---- Schedules G and H: net worth and the leverage ratio ----
    set('010A', A * 0.993);
    set('010B', A * 0.996);
    set('010C', A * 0.981);
    set('NW0010', get('010'));
    v.set('998', pct((get('997') / get('NW0010')) * 100));
    text.set('700', get('998') >= 7 ? 'Well Capitalized' : get('998') >= 6 ? 'Adequately Capitalized' : 'Undercapitalized');
    text.set('RB0172', 'Not required: CCULR elected');
    text.set('701', 'Not applicable: not a new credit union');
    text.set('LR0001', 'Yes');
    text.set('LR0008', 'Yes');

    // ---- General ledger: every other input on the two statements has its own account ----
    const named: Record<string, string> = { AS0004: 'Vault and teller cash', AS0005: 'Cash items in process', '730B1': 'Settlement account, corporate credit union', AS0003: 'Federal Reserve Bank account', '730B2': 'Correspondent bank accounts', AS0007: 'Certificates at other institutions', AS0055: 'Equity securities', AS0067: 'Investments, available for sale', AS0073: 'Investments, held to maturity', '769A': 'Nonperpetual capital, corporate CU', '769B': 'Perpetual contributed capital', AS0016: 'Other investments, CUSO', '003': 'Mortgages held for sale', AS0048: 'Allowance for credit losses, loans', AS0023: 'Foreclosed real estate', AS0024: 'Repossessed vehicles', AS0025: 'Other repossessed assets', '007': 'Land and buildings', '008': 'Furniture and equipment', '794': 'NCUSIF deposit', '779': 'Mortgage servicing rights', '009A': 'Accrued interest on loans', '009B': 'Accrued interest on investments', '009C': 'Prepaid and other assets', '825': 'Accounts payable and accrued expenses', '820A': 'Dividends payable', LI0003: 'Allowance, unfunded commitments', '860C': 'FHLB advances', '940': 'Undivided earnings', '658': 'Regular reserve', EQ0009: 'Unrealized gains (losses), AFS', '110': 'Interest income, loans', '119': 'Interest refunds', '120': 'Investment income', IS0005: 'Interest on balances at the Federal Reserve', '380': 'Dividends on shares', '340': 'Interest on borrowings', IS0011: 'Credit loss expense, loans', IS0016: 'Credit loss expense, unfunded commitments', '131': 'Fee income', IS0020: 'Interchange and CUSO income', IS0029: 'Gain on loan sales', '440': 'Other non-interest income', '210': 'Salaries and benefits', '230': 'Travel and conferences', '250': 'Occupancy', '260': 'Office operations', '270': 'Marketing', '280': 'Loan servicing', '290': 'Professional services', '310': 'Member insurance', '320': 'NCUA operating fee', '360': 'Miscellaneous expense' };
    for (const [code, name] of Object.entries(named)) if (get(code) !== 0) gl.push({ gl: '', name, line: code, amount: get(code) });
    return { values: v, text, gl };
  };

  const quarters = CR_QUARTERS.map((q, i) => build(q, i));

  // GL numbers follow the chart's ranges: assets 1, liabilities and shares 2, equity 3, income 4, expense 5.
  const range = (line: string) => {
    const [, schedule, , section] = NCUA_5300.find((l) => l[0] === line) ?? [];
    if (schedule === 'A') return 1300;
    if (line === '013') return 2500;
    if (schedule === 'SIE') return /Expense/.test(section ?? '') || /^(380|340|381|210|230|250|260|270|280|290|310|320|360|IS0011|IS0016)$/.test(line) ? 5000 : 4000;
    if (/Equity/.test(section ?? '')) return 3000;
    if (/Liabilities|Shares/.test(section ?? '')) return 2000;
    return 1000;
  };
  const numbers = new Map<string, string>();
  const next = new Map<number, number>();
  const glRows: unknown[][] = [];
  const [prior, current] = quarters as [Quarter, Quarter];
  for (const g of current.gl) {
    const key = `${g.line}|${g.name}`;
    if (!numbers.has(key)) {
      const base = range(g.line);
      const n = (next.get(base) ?? base) + 10;
      next.set(base, n);
      numbers.set(key, String(n));
    }
    const was = prior.gl.find((p) => p.line === g.line && p.name === g.name)?.amount ?? 0;
    glRows.push([numbers.get(key), g.name, g.amount, was, g.line, '2002-03-01', '2026-09-30', null, null]);
  }
  for (const [gl, name, amount, opened, last, likely, note] of UNMAPPED_GL) glRows.push([gl, name, amount, 0, null, opened, last, likely, note]);

  // Every line of the form, with where its figure comes from.
  const source = (code: string, schedule: string, kind: string) =>
    kind === 'total' ? 'Computed from the lines above' : schedule === 'A' ? 'Core loan system' : schedule === 'D' ? (code.startsWith('08') ? 'Member file' : 'Core share system') : schedule === 'G' || schedule === 'H' || schedule === 'I' ? 'Capital worksheet' : schedule === 'B' ? 'Investment accounting' : 'General ledger';
  const lineRows = NCUA_5300.map(([code, schedule, scheduleName, section, order, name, kind, formula]) => [code, schedule, scheduleName, section, order, name, kind, formula, source(code, schedule, kind)]);
  const valueRows: unknown[][] = [];
  CR_QUARTERS.forEach((q, i) => {
    const { values, text } = quarters[i]!;
    for (const [code, schedule] of NCUA_5300) {
      if (schedule === 'I') valueRows.push([code, q.end, null, 'Not required: CCULR elected']);
      else valueRows.push([code, q.end, values.has(code) ? values.get(code)! : null, text.get(code) ?? null]);
    }
  });

  // ---- Edits: NCUA's own (E0025, E0208) and DI's checks before filing ----
  const c = current.values;
  const g = (code: string) => c.get(code) ?? 0;
  const money = (n: number) => `$${Math.round(n).toLocaleString('en-US')}`;
  const unmapped = UNMAPPED_GL.reduce((s, x) => s + x[2], 0);
  // Balance-sheet lines that moved more than 25% and $250,000 need an explanation before filing.
  const moved = NCUA_5300.filter(([code, schedule, , , , , kind]) => schedule === 'SFC' && kind === 'input' && Math.abs(g(code) - (prior.values.get(code) ?? 0)) >= 250_000 && Math.abs(g(code) - (prior.values.get(code) ?? 0)) / Math.max(1, Math.abs(prior.values.get(code) ?? 0)) > 0.25).map((l) => l[0]);
  const paidDown = (prior.values.get('860C') ?? 0) - g('860C');
  const explained = new Map<string, string>([['860C', `Paid down ${money(paidDown)} of FHLB advances in August from certificate inflows and investment maturities.`]]);
  const checks: [string, string, string, string, string | null, string | null][] = [
    ['Total liabilities, shares and equity equal total assets', 'Pass', `014 and 010 are both ${money(g('010'))}.`, 'Error', 'E0025', '010,014'],
    ['Charge-offs don’t exceed total loans', 'Pass', `Charge-offs YTD ${money(g('550'))} against loans of ${money(g('025B'))}.`, 'Error', 'E0208', '550,025B'],
    ['Loans by type add up to total loans', 'Pass', `Schedule A, ${money(g('025B1'))}, equals 025B.`, 'Error', null, '025B1,025B'],
    ['Delinquency by type adds up to the total', 'Pass', `${money(g('041B'))} 60+ days, across ${g('041A').toLocaleString('en-US')} loans.`, 'Error', null, '041B,041A'],
    ['Shares add up', 'Pass', `Member shares and nonmember deposits equal 018, ${money(g('018'))}.`, 'Error', null, '013,880,018'],
    ['Insured and uninsured shares add up to total shares', 'Pass', `069A ${money(g('069A'))} plus 068A ${money(g('068A'))}.`, 'Error', null, '068A,069A,018'],
    ['Net income ties to the income statement', 'Pass', `661A, ${money(g('661A'))} year to date.`, 'Error', null, '661A'],
    ['GL accounts categorized', 'Fail', `${UNMAPPED_GL.length} uncategorized GL accounts, totalling ${money(unmapped)}.`, 'Error', null, null],
    ['Accounts balance', 'Pass', 'Assets equal liabilities and equity.', 'Error', null, null],
    ['Delinquency agrees with the core', 'Pass', 'Within tolerance.', 'Error', null, '041B'],
    ['Net income agrees with the GL', 'Pass', 'Within tolerance.', 'Error', null, '661A'],
    ['Large balance changes are explained', moved.every((m2) => explained.has(m2)) ? 'Pass' : 'Fail', `${moved.filter((m2) => !explained.has(m2)).length} of ${moved.length} lines that moved more than 25% from ${CR_FILING.priorQuarter} still need an explanation.`, 'Warning', null, moved.join(',')],
    ['Net worth ratio moved less than 50 basis points', 'Pass', `${g('998').toFixed(2)}%, against ${(prior.values.get('998') ?? 0).toFixed(2)}% at ${CR_FILING.priorQuarter}.`, 'Warning', null, '998'],
    ['Leverage ratio meets the CCULR minimum', 'Pass', `${g('998').toFixed(2)}% against the 9% the CCULR framework requires.`, 'Warning', null, '998,LR0001'],
  ];
  const explanations = moved.map((code) => [code, CR_FILING.periodEnd, explained.get(code) ?? null, explained.has(code) ? 'Written' : 'Needed', explained.has(code) ? 'Priya Shah' : null]);
  return { lines: lineRows, values: valueRows, gl: glRows, checks, explanations };
}
