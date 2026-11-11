// The general ledger behind the Call Report: monthly balances for thirteen months, daily balances for the
// month in progress, income and expense by cost center, the 2026 budget by cost center, and the journal
// entries for September and October to date. Built from the GL accounts the Call Report maps (cr_gl_account),
// so September 30 and June 30 tie to the Call Report exactly: balances for the balance sheet, year to date
// for income and expense. A small CUSO subsidiary is consolidated, with the parent's investment in it
// eliminated. All of it is demo data [Assumption: demo].
import { AS_OF, unit, type GeneratedTenant } from './generate.ts';

export const GL_DDL = [
  `CREATE TABLE gl_company (company_id INT PRIMARY KEY, name VARCHAR(80) NOT NULL, kind VARCHAR(30) NOT NULL)`,
  `CREATE TABLE gl_account (company_id INT NOT NULL, gl_number VARCHAR(8) NOT NULL, name VARCHAR(80) NOT NULL, type VARCHAR(10) NOT NULL, statement VARCHAR(2) NOT NULL, grp VARCHAR(60) NOT NULL, sort_order INT NOT NULL, PRIMARY KEY (company_id, gl_number))`,
  `CREATE TABLE gl_cost_center (cost_center VARCHAR(8) PRIMARY KEY, name VARCHAR(60) NOT NULL, department VARCHAR(40) NOT NULL)`,
  // Balance sheet accounts: the ending balance. Income and expense: the month's activity, by cost center.
  `CREATE TABLE gl_balance_month (month_end DATE NOT NULL, company_id INT NOT NULL, gl_number VARCHAR(8) NOT NULL, cost_center VARCHAR(8) NOT NULL, amount DECIMAL(18,2) NOT NULL, PRIMARY KEY (month_end, company_id, gl_number, cost_center))`,
  `CREATE TABLE gl_balance_day (day DATE NOT NULL, company_id INT NOT NULL, gl_number VARCHAR(8) NOT NULL, balance DECIMAL(18,2) NOT NULL, PRIMARY KEY (day, company_id, gl_number))`,
  `CREATE TABLE gl_budget (month_end DATE NOT NULL, gl_number VARCHAR(8) NOT NULL, cost_center VARCHAR(8) NOT NULL, amount DECIMAL(18,2) NOT NULL, PRIMARY KEY (month_end, gl_number, cost_center))`,
  `CREATE TABLE gl_journal (line_id INT AUTO_INCREMENT PRIMARY KEY, je_id VARCHAR(24) NOT NULL, posted DATE NOT NULL, company_id INT NOT NULL, gl_number VARCHAR(8) NOT NULL, cost_center VARCHAR(8) NOT NULL, debit DECIMAL(18,2) NOT NULL, credit DECIMAL(18,2) NOT NULL, description VARCHAR(160) NOT NULL, source VARCHAR(30) NOT NULL, ticket VARCHAR(30) NOT NULL, offset_gl VARCHAR(8) NULL, posted_by VARCHAR(60) NOT NULL, KEY ix_gl_journal (gl_number, posted), KEY ix_gl_je (je_id))`,
];

/** The months on file: November 2025 to September 2026 complete, and October 2026 to date. */
export const GL_MONTHS = ['2025-10-31', '2025-11-30', '2025-12-31', '2026-01-31', '2026-02-28', '2026-03-31', '2026-04-30', '2026-05-31', '2026-06-30', '2026-07-31', '2026-08-31', '2026-09-30', '2026-10-31'];
export const GL_OPEN_MONTH = '2026-10-31';
const NONE = '-';
/** Contra-assets: an allowance is carried as a positive balance and subtracts from the assets it reduces. */
export const CONTRA = /allowance for credit losses|^less:/i;

type Type = 'asset' | 'liability' | 'equity' | 'income' | 'expense';
interface Acct { gl: string; name: string; sep: number; jun: number; type: Type; group: string }

const BANK_EXPENSE = /^(interest on (?!balances)|expense|provision|salaries|expenses|other noninterest expense|applicable income taxes)/i;
function classify(gl: string, name: string, bank: boolean): { type: Type; group: string } {
  const n = Number(gl);
  if (bank) {
    if (n >= 4000) {
      const expense = BANK_EXPENSE.test(name);
      return { type: expense ? 'expense' : 'income', group: expense ? (/^interest|expense of other/i.test(name) ? 'Interest expense' : /provision/i.test(name) ? 'Provision for credit losses' : /taxes/i.test(name) ? 'Income taxes' : 'Non-interest expense') : /^interest|dividend income/i.test(name) ? 'Interest income' : 'Non-interest income' };
    }
    if (n >= 1110 && n <= 1130) return { type: 'liability', group: n === 1110 ? 'Deposits' : 'Borrowings and other liabilities' };
    if (n >= 1140 && n <= 1170) return { type: 'equity', group: 'Equity capital' };
    if (n === 2455) return { type: 'liability', group: 'Borrowings and other liabilities' };
    return { type: 'asset', group: n === 1050 || n === 1060 ? 'Loans, net' : n <= 1040 ? 'Cash and securities' : 'Premises and other assets' };
  }
  if (n >= 5000) return { type: 'expense', group: /dividends on shares|interest on borrowings/i.test(name) ? 'Dividends and interest expense' : /credit loss/i.test(name) ? 'Credit loss expense' : 'Operating expenses' };
  if (n >= 4000) return { type: 'income', group: /interest|investment|federal reserve/i.test(name) ? 'Interest income' : 'Non-interest income' };
  if (n >= 3000) return { type: 'equity', group: 'Equity' };
  if (n >= 2500) return { type: 'liability', group: 'Member shares' };
  if (n >= 2000) return { type: 'liability', group: 'Liabilities' };
  if (n >= 1300 || n === 1160) return { type: 'asset', group: 'Loans, net' };
  return { type: 'asset', group: n <= 1140 ? 'Cash and investments' : 'Other assets' };
}

/** Departments and their cost centers; each branch is its own cost center in Retail. */
function costCenters(branches: string[]) {
  const fixed: [string, string, string][] = [['300', 'Consumer and mortgage lending', 'Lending'], ['400', 'Operations and card services', 'Operations'], ['500', 'Information technology', 'Technology'], ['600', 'Marketing', 'Marketing'], ['700', 'Finance and treasury', 'Finance'], ['800', 'Executive and HR', 'Executive and HR']];
  return [...branches.map((b, i) => [String(110 + i * 10), `${b} branch`, 'Retail'] as [string, string, string]), ...fixed];
}

/** How an income or expense account spreads across cost centers, by what it is. */
function spread(name: string, type: Type, branchCcs: string[]): [string, number][] {
  const branches = (w: number) => branchCcs.map((c) => [c, w / branchCcs.length] as [string, number]);
  const n = name.toLowerCase();
  if (/salar/.test(n)) return [...branches(0.45), ['300', 0.15], ['400', 0.12], ['500', 0.08], ['600', 0.04], ['700', 0.06], ['800', 0.1]];
  if (/occupancy|premises/.test(n)) return [...branches(0.8), ['400', 0.1], ['800', 0.1]];
  if (/office operations|other noninterest expense/.test(n)) return [...branches(0.25), ['500', 0.45], ['400', 0.3]];
  if (/marketing/.test(n)) return [['600', 1]];
  if (/travel/.test(n)) return [['800', 0.4], ['300', 0.3], ['600', 0.3]];
  if (/loan servicing/.test(n)) return [['300', 1]];
  if (/professional/.test(n)) return [['700', 0.5], ['800', 0.3], ['500', 0.2]];
  if (/miscellaneous/.test(n)) return [['400', 1]];
  if (type === 'income' && /fee|service charges|interchange|card/.test(n)) return [...branches(0.7), ['400', 0.3]];
  if (type === 'income' && /loans/.test(n)) return [['300', 1]];
  return [['700', 1]];
}

const round2 = (n: number) => Math.round(n * 100) / 100;
/** Split a total into parts with these weights, exactly to the cent. */
function split(total: number, weights: number[]) {
  const sum = weights.reduce((a, b) => a + b, 0) || 1;
  const parts = weights.map((w) => round2((total * w) / sum));
  parts[parts.length - 1] = round2(parts.at(-1)! + total - parts.reduce((a, b) => a + b, 0));
  return parts;
}

export function generateGl(t: GeneratedTenant, crGl: unknown[][], bank: boolean) {
  const branches = (t.locations as unknown[][]).map((l) => String(l[1]));
  const ccs = costCenters(branches);
  const branchCcs = ccs.filter((c) => c[2] === 'Retail').map((c) => c[0]);
  const parent = bank ? 'The bank' : 'The credit union';
  const sub = bank ? 'Harbor Title & Insurance Agency LLC' : 'CU Insurance Services LLC (CUSO)';
  const companies = [[1, parent, bank ? 'Bank' : 'Credit union'], [2, sub, 'Subsidiary'], [9, 'Eliminations', 'Consolidation']];

  const accts: Acct[] = crGl.map((g) => ({ gl: String(g[0]), name: String(g[1]), sep: Number(g[2]), jun: Number(g[3]), ...classify(String(g[0]), String(g[1]), bank) }));
  // The subsidiary's own small ledger, and the parent's investment in it eliminated on consolidation.
  const invest = bank ? 1_850_000 : 1_250_000;
  const subAccts: Acct[] = [
    { gl: '1010', name: 'Cash', sep: invest + 260_000, jun: invest + 205_000, type: 'asset', group: bank ? 'Cash and securities' : 'Cash and investments' },
    { gl: '1240', name: 'Commissions receivable', sep: 96_000, jun: 88_000, type: 'asset', group: bank ? 'Premises and other assets' : 'Other assets' },
    { gl: '3020', name: 'Members’ equity', sep: invest, jun: invest, type: 'equity', group: bank ? 'Equity capital' : 'Equity' },
    { gl: '3025', name: 'Retained earnings, subsidiary', sep: 0, jun: 0, type: 'equity', group: bank ? 'Equity capital' : 'Equity' },
    { gl: '4070', name: 'Insurance commissions', sep: 612_000, jun: 398_000, type: 'income', group: 'Non-interest income' },
    { gl: '5010', name: 'Salaries and benefits', sep: 455_000, jun: 302_000, type: 'expense', group: bank ? 'Non-interest expense' : 'Operating expenses' },
  ];
  // The subsidiary closes its profit to retained earnings monthly, as the parent does: assets = equity.
  subAccts[3]!.sep = subAccts[0]!.sep + subAccts[1]!.sep - invest;
  subAccts[3]!.jun = subAccts[0]!.jun + subAccts[1]!.jun - invest;
  const elimGl = bank ? '1100' : '1140';
  const elim: Acct[] = [
    { gl: elimGl, name: `Investment in ${sub}, eliminated`, sep: -invest, jun: -invest, type: 'asset', group: bank ? 'Premises and other assets' : 'Cash and investments' },
    { gl: '3020', name: `${sub} equity, eliminated`, sep: -invest, jun: -invest, type: 'equity', group: bank ? 'Equity capital' : 'Equity' },
  ];

  const order = new Map<string, number>();
  const account = [...accts.map((a, i) => [1, a.gl, a.name, a.type, a.type === 'income' || a.type === 'expense' ? 'IS' : 'BS', a.group, i]), ...subAccts.map((a, i) => [2, a.gl, a.name, a.type, a.type === 'income' || a.type === 'expense' ? 'IS' : 'BS', a.group, 1000 + i]), ...elim.map((a, i) => [9, a.gl, a.name, a.type, 'BS', a.group, 2000 + i])];
  account.forEach((a) => order.set(`${a[0]}|${a[1]}`, a[6] as number));

  const months: unknown[][] = [];
  const days: unknown[][] = [];
  const budget: unknown[][] = [];
  const journal: unknown[][] = [];
  const idx = (m: string) => GL_MONTHS.indexOf(m);
  const SEP = idx('2026-09-30');
  const JUN = idx('2026-06-30');
  const OCT_FRACTION = 25 / 31;
  const asOfDay = Number(AS_OF.slice(8, 10));

  /** Month-end balances: exact at June and September, growing between, noise elsewhere; October to date. */
  const balances = (a: Acct, key: number) => {
    const ratio = a.jun && Math.sign(a.jun) === Math.sign(a.sep) ? Math.min(1.08, Math.max(0.93, Math.pow(a.sep / a.jun, 1 / 3))) : 1;
    return GL_MONTHS.map((m, i) => {
      if (i === SEP) return a.sep;
      if (i === JUN) return a.jun;
      const steps = i === GL_MONTHS.length - 1 ? OCT_FRACTION : i - SEP;
      const base = i > JUN && i < SEP ? a.jun + ((a.sep - a.jun) * (i - JUN)) / 3 : a.sep * Math.pow(ratio, steps);
      return round2(base * (1 + (unit(key, i * 7 + 1) - 0.5) * 0.012));
    });
  };
  /** Monthly activity: January to June adds to June's year to date, July to September to the rest. */
  const activity = (a: Acct, key: number) => {
    const w = (i: number) => 0.9 + unit(key, i * 11 + 3) * 0.2;
    const h1 = split(a.jun, [3, 4, 5, 6, 7, 8].map(w));
    const q3 = split(a.sep - a.jun, [9, 10, 11].map(w));
    const avg = a.sep / 9;
    return [round2(avg * w(0)), round2(avg * w(1)), round2(avg * w(2)), ...h1, ...q3, round2(avg * OCT_FRACTION * w(12))];
  };

  const entries = (company: number, a: Acct, cc: string, m: string, delta: number, key: number) => {
    // Journal entries for September and October to date, adding exactly to the month's movement.
    if (m !== '2026-09-30' && m !== GL_OPEN_MONTH) return;
    const lastDay = m === GL_OPEN_MONTH ? asOfDay : 30;
    const ym = m.slice(0, 7);
    const daily = a.type === 'asset' || a.type === 'liability' || (a.type === 'income' && /interest|fee|charges|interchange|loans/i.test(a.name));
    const kind = /salar/i.test(a.name) ? 'payroll' : daily ? 'core' : a.type === 'expense' || a.type === 'income' ? 'ap' : 'manual';
    const dates = kind === 'payroll' ? [15, lastDay].filter((d, i, all) => all.indexOf(d) === i && d <= lastDay) : kind === 'core' ? Array.from({ length: lastDay }, (_, i) => i + 1).filter((d) => new Date(`${ym}-${String(d).padStart(2, '0')}T00:00:00Z`).getUTCDay() % 6 !== 0) : Array.from({ length: 3 + Math.floor(unit(key, 41) * 6) }, (_, i) => 1 + Math.floor(unit(key, 50 + i) * lastDay)).sort((x, y) => x - y);
    if (!dates.length || Math.abs(delta) < 0.01) return;
    const parts = kind === 'core' ? split(delta, dates.map((_, i) => 0.6 + unit(key, 70 + i))) : split(delta, dates.map((_, i) => 0.5 + unit(key, 90 + i)));
    const debitNormal = (a.type === 'asset' && !CONTRA.test(a.name)) || a.type === 'expense';
    const offset = a.type === 'expense' ? (bank ? '1130' : '2010') : a.type === 'income' ? (bank ? '1010' : '1050') : bank ? '1010' : '1050';
    dates.forEach((d, i) => {
      const amt = parts[i]!;
      if (!amt) return;
      const posted = `${ym}-${String(d).padStart(2, '0')}`;
      const n = String(journal.length + 1).padStart(5, '0');
      const [source, ticket, desc, by] =
        kind === 'payroll' ? ['Payroll', `PR-${ym}-${d <= 15 ? '1' : '2'}`, `Payroll, period ending ${posted}`, 'Payroll interface']
        : kind === 'core' ? ['Core daily posting', `CORE-${posted.replace(/-/g, '')}`, `Daily posting from the core: ${a.name.toLowerCase()}`, 'Core interface']
        : kind === 'ap' ? ['Accounts payable', `AP-${48000 + Math.floor(unit(key, 120 + i) * 9000)}`, `${a.name}: vendor invoice`, 'AP interface']
        : ['Manual journal', `MJ-${ym}-${String(i + 1).padStart(3, '0')}`, `${a.name}: month-end adjustment`, 'Priya Shah'];
      // A positive amount increases the account: a debit for assets and expenses, a credit otherwise.
      const dr = (amt > 0) === debitNormal ? Math.abs(amt) : 0;
      const cr = dr ? 0 : Math.abs(amt);
      journal.push([`JE-${ym}-${n}`, posted, company, a.gl, cc, dr, cr, desc.slice(0, 160), source, ticket, offset, by]);
    });
  };

  const emit = (company: number, list: Acct[]) => {
    for (const [k, a] of list.entries()) {
      const key = company * 10_000 + Number(a.gl) + k;
      if (a.type === 'income' || a.type === 'expense') {
        const acts = activity(a, key);
        const weights = company === 1 ? spread(a.name, a.type, branchCcs) : [['700', 1] as [string, number]];
        GL_MONTHS.forEach((m, i) => {
          const byCc = split(acts[i]!, weights.map((w) => w[1]));
          weights.forEach(([cc], j) => {
            months.push([m, company, a.gl, cc, byCc[j]]);
            entries(company, a, cc, m, byCc[j]!, key + j * 101);
          });
        });
        // The 2026 budget by cost center, against the plan: some lines run over (marketing, technology), some income under.
        if (company === 1) {
          const plan = /marketing/i.test(a.name) ? 0.85 : /office operations|other noninterest expense/i.test(a.name) ? 0.92 : /salar/i.test(a.name) ? 1.03 : /fee income|service charges/i.test(a.name) ? 1.06 : a.type === 'income' && /interest/i.test(a.name) ? 0.98 : 1.01;
          const monthly = (a.sep / 9) * plan;
          for (const m of GL_MONTHS.slice(3).concat(['2026-11-30', '2026-12-31'])) {
            const early = m <= '2026-06-30';
            const amount = early ? (a.jun / 6) * (1 + (plan - 1) * 0.3) : monthly;
            const byCc = split(round2(amount), weights.map((w) => w[1]));
            weights.forEach(([cc], j) => budget.push([m, a.gl, cc, byCc[j]]));
          }
        }
      } else {
        const { bals, daily } = bs.get(a.gl)!;
        GL_MONTHS.forEach((m, i) => {
          months.push([m, company, a.gl, NONE, bals[i]]);
          if (i > 0) entries(company, a, NONE, m, round2(bals[i]! - bals[i - 1]!), key);
        });
        daily.forEach((v, d) => days.push([`2026-10-${String(d + 1).padStart(2, '0')}`, company, a.gl, v]));
      }
    }
  };
  /**
   * Balance-sheet balances for a company, kept in balance: June and September are the Call Report's
   * own figures; in every other month and day cash takes the difference, as it would in the ledger.
   */
  let bs = new Map<string, { bals: number[]; daily: number[] }>();
  const balanceSheet = (list: Acct[], company: number, plugGl: string) => {
    const out = new Map<string, { bals: number[]; daily: number[] }>();
    const sign = (a: Acct) => (a.type === 'asset' ? (CONTRA.test(a.name) ? -1 : 1) : -1);
    for (const [k, a] of list.entries()) {
      if (a.type === 'income' || a.type === 'expense') continue;
      const key = company * 10_000 + Number(a.gl) + k;
      const bals = balances(a, key);
      const from = bals[SEP]!;
      const to = bals.at(-1)!;
      const daily = Array.from({ length: asOfDay }, (_, d) => (d + 1 === asOfDay ? to : round2(from + ((to - from) * (d + 1)) / asOfDay + (unit(key, 301 + d) - 0.5) * Math.abs(to - from) * 0.2)));
      out.set(a.gl, { bals, daily });
    }
    const plug = out.get(plugGl)!;
    const off = (pick: (v: { bals: number[]; daily: number[] }) => number) => round2(list.filter((a) => out.has(a.gl)).reduce((s, a) => s + sign(a) * pick(out.get(a.gl)!), 0));
    GL_MONTHS.forEach((_, i) => {
      if (i === JUN || i === SEP) return;
      plug.bals[i] = round2(plug.bals[i]! - off((v) => v.bals[i]!));
    });
    plug.daily.forEach((_, d) => (plug.daily[d] = round2(plug.daily[d]! - off((v) => v.daily[d]!))));
    return out;
  };
  // What the unmapped suspense accounts leave out of balance is held in one offsetting account until reconciled.
  const residual = (m: 'sep' | 'jun') => round2(accts.filter((a) => a.type !== 'income' && a.type !== 'expense').reduce((s, a) => s + (a.type === 'asset' ? (CONTRA.test(a.name) ? -1 : 1) : -1) * a[m], 0));
  accts.push({ gl: '2390', name: 'Suspense offsets, pending reconciliation', sep: residual('sep'), jun: residual('jun'), type: 'liability', group: bank ? 'Borrowings and other liabilities' : 'Liabilities' });
  account.push([1, '2390', 'Suspense offsets, pending reconciliation', 'liability', 'BS', bank ? 'Borrowings and other liabilities' : 'Liabilities', 999]);
  bs = balanceSheet(accts, 1, bank ? '1020' : '1060');
  emit(1, accts);
  bs = balanceSheet(subAccts, 2, '1010');
  emit(2, subAccts);
  for (const a of elim) {
    GL_MONTHS.forEach((m) => months.push([m, 9, a.gl, NONE, a.sep]));
    for (let d = 1; d <= asOfDay; d++) days.push([`2026-10-${String(d).padStart(2, '0')}`, 9, a.gl, a.sep]);
  }
  return { companies, accounts: account, costCenters: ccs, months, days, budget, journal };
}
