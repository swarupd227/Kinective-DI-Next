// ESP alignment, phase 5: services and channel activity.
// - cdm_login: each online and mobile banking login over the last 90 days (ESP's crm_onlinelogins and
//   crm_mobilelogins). They add up to cdm_party_activity's 90-day counts, and each person's latest is
//   cdm_digital_usage.last_login.
// - cdm_service_type: the services an account, a share or a loan can carry (ESP's account, deposit and
//   loan service products).
// - cdm_account_service: online and mobile banking, e-statements, bill pay, mobile deposit and phone
//   banking on each account, with when they were added and removed (ESP's accountservicedata). They
//   follow cdm_digital_usage's dates and cdm_account.estatements.
// - cdm_deposit_service: courtesy pay (a bank's overdraft privilege), overdraft transfer, direct deposit
//   and debit cards on each share (ESP's depositservicedata). Direct deposit follows cdm_digital_usage,
//   debit cards follow cdm_card, and every checking account charged an overdraft fee has courtesy pay.
// - cdm_loan_service: GAP, mechanical repair coverage and debt protection sold with each loan, with the
//   price and who sold it (ESP's loanservicedata). One indirect dealer sells them on far more of its
//   loans than the others, the pattern a payment-packing review looks for; one branch sells GAP on far
//   fewer of its direct auto loans, income left on the table.
// - cdm_product_service: which services each loan product allows (ESP's allowedServices).
// The channel tables ESP keeps (debit, bill pay, direct deposit, mobile and online transactions) need no
// table here: each posted transaction carries its channel and code.
// IP addresses come from the ranges set aside for documentation (RFC 5737), so none is anyone's.
import { AS_OF, unit } from './generate.ts';

export const ESP_SERVICE_DDL = [
  `CREATE TABLE cdm_login (
     login_id INT PRIMARY KEY,
     party_id INT NOT NULL,
     kind VARCHAR(8) NOT NULL,
     login_time DATETIME NOT NULL,
     ip_address VARCHAR(45) NOT NULL,
     KEY ix_login_party (party_id, login_time),
     KEY ix_login_time (login_time)
   )`,
  `CREATE TABLE cdm_service_type (
     service_id INT PRIMARY KEY,
     applies_to VARCHAR(8) NOT NULL,
     code VARCHAR(10) NOT NULL,
     name VARCHAR(50) NOT NULL,
     description VARCHAR(200) NOT NULL,
     maximum_amount DECIMAL(10,2) NULL,
     cross_sell_group VARCHAR(16) NULL,
     allow_suggestion TINYINT NOT NULL,
     enabled TINYINT NOT NULL
   )`,
  `CREATE TABLE cdm_account_service (
     account_service_id INT PRIMARY KEY,
     account_number VARCHAR(12) NOT NULL,
     service_id INT NOT NULL,
     added DATE NOT NULL,
     removed DATE NULL,
     employee_id INT NULL,
     branch_id INT NULL,
     KEY ix_as_account (account_number),
     KEY ix_as_service (service_id)
   )`,
  `CREATE TABLE cdm_deposit_service (
     deposit_service_id INT PRIMARY KEY,
     account_id INT NOT NULL,
     service_id INT NOT NULL,
     added DATE NOT NULL,
     removed DATE NULL,
     employee_id INT NULL,
     branch_id INT NULL,
     KEY ix_ds_account (account_id),
     KEY ix_ds_service (service_id)
   )`,
  `CREATE TABLE cdm_loan_service (
     loan_service_id INT PRIMARY KEY,
     loan_id INT NOT NULL,
     service_id INT NOT NULL,
     amount DECIMAL(10,2) NOT NULL,
     added DATE NOT NULL,
     removed DATE NULL,
     employee_id INT NULL,
     branch_id INT NULL,
     KEY ix_ls_loan (loan_id),
     KEY ix_ls_service (service_id)
   )`,
  `CREATE TABLE cdm_product_service (
     product_id VARCHAR(24) NOT NULL,
     service_id INT NOT NULL,
     PRIMARY KEY (product_id, service_id)
   )`,
];

export const ESP_SERVICE_COLUMNS = {
  cdm_login: ['login_id', 'party_id', 'kind', 'login_time', 'ip_address'],
  cdm_service_type: ['service_id', 'applies_to', 'code', 'name', 'description', 'maximum_amount', 'cross_sell_group', 'allow_suggestion', 'enabled'],
  cdm_account_service: ['account_service_id', 'account_number', 'service_id', 'added', 'removed', 'employee_id', 'branch_id'],
  cdm_deposit_service: ['deposit_service_id', 'account_id', 'service_id', 'added', 'removed', 'employee_id', 'branch_id'],
  cdm_loan_service: ['loan_service_id', 'loan_id', 'service_id', 'amount', 'added', 'removed', 'employee_id', 'branch_id'],
  cdm_product_service: ['product_id', 'service_id'],
} as const;

const DAY = 86_400_000;
const ymd = (t: number) => new Date(t).toISOString().slice(0, 10);
const day = (v: unknown) => (v === null || v === undefined ? null : v instanceof Date ? v.toISOString().slice(0, 10) : String(v).slice(0, 10));
const asOfT = Date.parse(`${AS_OF}T00:00:00Z`);
/** A date between two others, picked by the salt. */
const between = (from: string, to: string, u: number) => {
  const a = Date.parse(`${from}T00:00:00Z`);
  const b = Math.max(a, Date.parse(`${to}T00:00:00Z`));
  return ymd(a + Math.floor(u * ((b - a) / DAY + 1)) * DAY);
};
const later = (a: string, b: string) => (a > b ? a : b);

export type ServiceCode = 'OLB' | 'MOB' | 'ESTMT' | 'BILLPAY' | 'RDC' | 'PHONE' | 'CPAY' | 'ODT' | 'DD' | 'DEBIT' | 'GAP' | 'MRC' | 'DP';

/** The service types: [id, applies to, code, name, description, maximum amount, cross-sell group, suggest?]. */
export function serviceTypes(institutionType: 'credit_union' | 'bank') {
  const bank = institutionType === 'bank';
  const rows: [number, string, ServiceCode, string, string, number | null, string | null, number][] = [
    [1, 'account', 'OLB', 'Online banking', 'Signed up for online banking.', null, 'DIGITAL', 1],
    [2, 'account', 'MOB', 'Mobile banking', 'Signed up for the mobile app.', null, 'DIGITAL', 1],
    [3, 'account', 'ESTMT', 'E-statements', 'Statements by email instead of mail.', null, 'DIGITAL', 1],
    [4, 'account', 'BILLPAY', 'Bill pay', 'Pays bills from online or mobile banking.', null, 'DIGITAL', 1],
    [5, 'account', 'RDC', 'Mobile deposit', 'Deposits checks from the mobile app.', null, 'DIGITAL', 1],
    [6, 'account', 'PHONE', 'Phone banking', 'Balances and transfers by phone, through the automated line.', null, 'DIGITAL', 0],
    [7, 'deposit', 'CPAY', bank ? 'Overdraft privilege' : 'Courtesy pay', bank ? 'Pays items that would overdraw checking, for a fee, up to a limit.' : 'Pays items that would overdraw checking, for a fee, up to a limit.', 500, 'CHECKING', 0],
    [8, 'deposit', 'ODT', 'Overdraft transfer', bank ? 'Covers an overdraft from the customer’s savings.' : 'Covers an overdraft from the member’s savings.', null, 'CHECKING', 1],
    [9, 'deposit', 'DD', 'Direct deposit', 'A paycheck or benefit deposited automatically.', null, 'CHECKING', 1],
    [10, 'deposit', 'DEBIT', 'Debit card', 'A debit card on the account.', null, 'CHECKING', 1],
    [11, 'loan', 'GAP', 'GAP coverage', 'Pays the difference between the loan balance and the vehicle’s value if it is totaled or stolen.', 1095, 'AUTO', 1],
    [12, 'loan', 'MRC', 'Mechanical repair coverage', 'A vehicle service contract for repairs after the warranty.', 3495, 'AUTO', 1],
    [13, 'loan', 'DP', 'Debt protection', 'Cancels or suspends payments on death, disability or job loss, for a monthly fee.', 75, 'PROTECTION', 1],
  ];
  return rows.map((r) => [...r, 1]);
}

const SERVICE_ID = Object.fromEntries(serviceTypes('credit_union').map((r) => [r[2], r[0]])) as Record<ServiceCode, number>;

/** Which add-ons each loan category allows. */
const ALLOWED: Record<string, ServiceCode[]> = {
  Auto: ['GAP', 'MRC', 'DP'],
  Personal: ['DP'],
  Consumer: ['DP'],
  'Credit Card': ['DP'],
  HELOC: ['DP'],
};

export interface ServiceInputs {
  institutionType: 'credit_union' | 'bank';
  /** cdm_loan rows. */
  loans: unknown[][];
  /** cdm_deposit_account rows. */
  deposits: unknown[][];
  /** cdm_digital_usage rows: [party, online since, mobile since, mobile deposit since, e-statements since, bill pay since, direct deposit, changed, last login]. */
  digital: unknown[][];
  /** cdm_party rows. */
  parties: unknown[][];
  /** cdm_card rows. */
  cards: unknown[][];
  /** cdm_account rows. */
  accounts: unknown[][];
  /** cdm_account_holding rows. */
  holdings: unknown[][];
  /** cdm_loan_product rows: [product, name, category, ...]. */
  loanProducts: unknown[][];
  /** cdm_loan_terms rows (dealer last). */
  loanTerms: unknown[][];
  /** cdm_account_origination rows: [kind, id, employee, branch, channel]. */
  origination: unknown[][];
  /** cdm_share_transaction rows, for the overdraft fees. */
  share: unknown[][];
  /** cdm_employee rows: [employee, name, role, branch]. */
  employees: unknown[][];
}

/** How often each add-on is sold with a loan, by category and channel. */
const ATTACH: Record<string, Partial<Record<ServiceCode, number>>> = {
  'Auto|direct': { GAP: 0.38, MRC: 0.12, DP: 0.18 },
  'Auto|indirect': { GAP: 0.5, MRC: 0.26, DP: 0.09 },
  Personal: { DP: 0.22 },
  Consumer: { DP: 0.17 },
  'Credit Card': { DP: 0.07 },
  HELOC: { DP: 0.05 },
};
/** What each add-on costs: [low, high]. Debt protection is a monthly fee. */
const PRICE: Partial<Record<ServiceCode, [number, number]>> = { GAP: [395, 895], MRC: [1295, 2995], DP: [12, 75] };

export function generateServices(x: ServiceInputs) {
  const bank = x.institutionType === 'bank';
  const types = serviceTypes(x.institutionType);
  const originBy = new Map(x.origination.map((o) => [`${o[0]}|${o[1]}`, { employee: o[2] as number | null, branch: o[3] as number | null }]));
  const dealerCol = 12;
  const dealerOf = new Map(x.loanTerms.filter((t) => t[dealerCol] !== null && t[dealerCol] !== undefined).map((t) => [Number(t[0]), Number(t[dealerCol])]));
  const categoryOfProduct = new Map(x.loanProducts.map((p) => [String(p[0]), String(p[2])]));

  // Which services each loan product allows.
  const productServices: unknown[][] = [];
  for (const [product, category] of categoryOfProduct) for (const code of ALLOWED[category] ?? []) productServices.push([product, SERVICE_ID[code]]);

  // Loan add-ons, sold at origination. One busy dealer packs them in; one branch rarely offers GAP.
  const yearAgo = ymd(asOfT - 365 * DAY);
  const dealerLoans = new Map<number, number>();
  const branchAuto = new Map<number, number>();
  for (const l of x.loans) {
    if (l[4] !== 'Auto' || String(day(l[6])) < yearAgo) continue;
    if (Number(l[5])) {
      const d = dealerOf.get(Number(l[0]));
      if (d !== undefined) dealerLoans.set(d, (dealerLoans.get(d) ?? 0) + 1);
    } else branchAuto.set(Number(l[2]), (branchAuto.get(Number(l[2])) ?? 0) + 1);
  }
  const rankedDealers = [...dealerLoans].sort((a, b) => b[1] - a[1] || a[0] - b[0]);
  const packer = rankedDealers[Math.min(2, rankedDealers.length - 1)]?.[0] ?? null;
  const rankedBranches = [...branchAuto].sort((a, b) => b[1] - a[1] || a[0] - b[0]);
  const shyBranch = rankedBranches[Math.min(1, rankedBranches.length - 1)]?.[0] ?? null;

  const loanServices: unknown[][] = [];
  let lsId = 1;
  for (const l of x.loans) {
    const id = Number(l[0]);
    const category = String(l[4]);
    const indirect = Number(l[5]) === 1;
    const rates = ATTACH[category === 'Auto' ? `Auto|${indirect ? 'indirect' : 'direct'}` : category];
    if (!rates) continue;
    const open = String(day(l[6]));
    const ended = day(l[8]) ?? day(l[7]);
    const dealer = indirect ? dealerOf.get(id) : undefined;
    const origin = originBy.get(`loan|${id}`);
    for (const [code, base] of Object.entries(rates) as [ServiceCode, number][]) {
      let p = base;
      if (dealer !== undefined && dealer === packer) p = code === 'GAP' ? 0.9 : code === 'MRC' ? 0.68 : code === 'DP' ? 0.3 : p;
      if (!indirect && Number(l[2]) === shyBranch && code === 'GAP') p *= 0.3;
      if (unit(id, 5100 + SERVICE_ID[code]) >= p) continue;
      const [lo, hi] = PRICE[code]!;
      // Dealers price add-ons higher than the credit union's own desk.
      const price = Math.round((lo + unit(id, 5120 + SERVICE_ID[code]) * (hi - lo)) * (indirect && code !== 'DP' ? 1.15 : 1) * 100) / 100;
      // A few borrowers cancel debt protection; GAP and repair coverage end with the loan.
      const cancelled = code === 'DP' && unit(id, 5140) < 0.08 ? between(open, AS_OF, unit(id, 5141)) : null;
      loanServices.push([lsId++, id, SERVICE_ID[code], price, open, cancelled ?? ended, indirect ? null : (origin?.employee ?? Number(l[3])), Number(l[2])]);
    }
  }

  // Services on each share: courtesy pay and overdraft transfer on checking, direct deposit, debit cards.
  const digitalBy = new Map(x.digital.map((d) => [Number(d[0]), d]));
  const odFee = new Set(x.share.filter((s) => s[4] === 'FEE-OD').map((s) => Number(s[1])));
  const savingsBy = new Set(x.deposits.filter((d) => !d[5] && /savings/i.test(String(d[3]))).map((d) => Number(d[1])));
  const firstChecking = new Map<number, unknown[]>();
  for (const d of x.deposits) {
    if (d[3] !== 'Checking' || d[5]) continue;
    const prev = firstChecking.get(Number(d[1]));
    if (!prev || String(day(d[4])) < String(day(prev[4]))) firstChecking.set(Number(d[1]), d);
  }
  const depositServices: unknown[][] = [];
  let dsId = 1;
  for (const d of x.deposits) {
    if (d[3] !== 'Checking') continue;
    const id = Number(d[0]);
    const party = Number(d[1]);
    const open = String(day(d[4]));
    const closed = day(d[5]);
    const origin = originBy.get(`deposit|${id}`);
    const by = origin?.employee ?? null;
    const branch = origin?.branch ?? Number(d[2]);
    // Courtesy pay: most members opt in when they open checking; everyone charged an overdraft fee has.
    const optIn = odFee.has(id) || unit(id, 5200) < (bank ? 0.48 : 0.58);
    if (optIn) {
      const optedOut = !odFee.has(id) && unit(id, 5201) < 0.06 ? between(open, AS_OF, unit(id, 5202)) : null;
      depositServices.push([dsId++, id, SERVICE_ID.CPAY, unit(id, 5203) < 0.8 ? open : between(open, AS_OF, unit(id, 5204)), optedOut ?? closed, by, branch]);
    }
    if (savingsBy.has(party) && unit(id, 5210) < 0.24) depositServices.push([dsId++, id, SERVICE_ID.ODT, between(open, AS_OF, unit(id, 5211) * 0.5), closed, by, branch]);
    // Direct deposit sits on the person's first open checking account, as cdm_digital_usage records it.
    const dig = digitalBy.get(party);
    if (dig && firstChecking.get(party) === d && (dig[6] === 'active' || dig[6] === 'stopped')) {
      const changed = day(dig[7]);
      const added = dig[6] === 'active' ? (changed ?? open) : between(open, changed ?? AS_OF, unit(id, 5220) * 0.6);
      depositServices.push([dsId++, id, SERVICE_ID.DD, later(added, open), dig[6] === 'stopped' ? changed : null, null, branch]);
    }
  }
  for (const c of x.cards) {
    if (c[2] !== 'Debit') continue;
    const activated = day(c[6]) ?? day(c[5]);
    depositServices.push([dsId++, Number(c[8]), SERVICE_ID.DEBIT, String(activated), day(c[7]), null, null]);
  }

  // Services on each account: the person's digital services on every open account they own, as
  // cdm_digital_usage dates them; e-statements as each account records them; phone banking.
  const partyBy = new Map(x.parties.map((p) => [Number(p[0]), p]));
  const accountServices: unknown[][] = [];
  let asId = 1;
  for (const a of x.accounts) {
    if (a[6]) continue;
    const number = String(a[0]);
    const party = Number(a[1]);
    const open = String(day(a[5]));
    const dig = digitalBy.get(party);
    const branch = Number(a[3]);
    if (dig) {
      for (const [code, col] of [['OLB', 1], ['MOB', 2], ['RDC', 3], ['BILLPAY', 5]] as [ServiceCode, number][]) {
        const since = day(dig[col]);
        if (since) accountServices.push([asId++, number, SERVICE_ID[code], later(since, open), null, null, branch]);
      }
    }
    if (Number(a[7])) accountServices.push([asId++, number, SERVICE_ID.ESTMT, later(day(dig?.[4]) ?? open, open), null, null, branch]);
    // Phone banking: older members use the automated line more.
    const birth = day(partyBy.get(party)?.[3]);
    const age = birth ? (asOfT - Date.parse(`${birth}T00:00:00Z`)) / (365.25 * DAY) : 45;
    if (unit(party, 5300) < (age >= 60 ? 0.42 : age >= 40 ? 0.22 : 0.08)) accountServices.push([asId++, number, SERVICE_ID.PHONE, between(open, AS_OF, unit(party, 5301) * 0.4), null, null, branch]);
  }

  return { types, productServices, loanServices, depositServices, accountServices, packerDealer: packer, shyBranch };
}

const IP_BLOCKS = ['192.0.2', '198.51.100', '203.0.113'];

/**
 * Each login over the last 90 days, a batch of rows at a time so a million logins never sit in memory:
 * as many as cdm_party_activity counts for each person, mobile and online, the last on the day
 * cdm_digital_usage records.
 */
export function* generateLogins(activity: unknown[][], digital: unknown[][], batch = 50_000): Generator<unknown[][]> {
  const digitalBy = new Map(digital.map((d) => [Number(d[0]), d]));
  let rows: unknown[][] = [];
  let id = 1;
  const windowStart = asOfT - 89 * DAY;
  for (const a of activity) {
    const party = Number(a[0]);
    const total = Number(a[1]);
    const mobile = Number(a[2]);
    if (!total) continue;
    const last = day(digitalBy.get(party)?.[8]);
    if (!last) continue;
    const lastT = Date.parse(`${last}T00:00:00Z`);
    const from = Math.min(lastT, windowStart);
    // Each person logs in from a home address or two; the phone's address changes with the network.
    const home = [`${IP_BLOCKS[party % 3]}.${1 + (party % 254)}`, `${IP_BLOCKS[(party + 1) % 3]}.${1 + ((party * 7) % 254)}`];
    for (let i = 0; i < total; i++) {
      const isLast = i === total - 1;
      const kind = i < mobile ? 'Mobile' : 'Online';
      const dayT = isLast ? lastT : from + Math.floor(unit(party * 131 + i, 5400) * ((lastT - from) / DAY + 1)) * DAY;
      const minutes = 6 * 60 + Math.floor(unit(party * 137 + i, 5401) * 17 * 60);
      const time = new Date(dayT + minutes * 60_000).toISOString().slice(0, 19).replace('T', ' ');
      const ip = kind === 'Mobile' ? `${IP_BLOCKS[(party + i) % 3]}.${1 + Math.floor(unit(party * 139 + i, 5402) * 254)}` : home[unit(party * 149 + i, 5403) < 0.85 ? 0 : 1];
      rows.push([id++, party, kind, time, ip]);
      if (rows.length >= batch) {
        yield rows;
        rows = [];
      }
    }
  }
  if (rows.length) yield rows;
}
