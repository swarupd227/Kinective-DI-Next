// ESP alignment, phase 1: the account (ESP's crm_accountdata, the membership or account number), which
// account each loan and share sits under, households (crm_householddata), the customer details DI didn't
// keep (crm_customerdata: member number, middle and preferred name, TIN type, language, deceased,
// marketing opt-out, address) and loan and share terms (finbi_loandata, finbi_sharedata: payment, due
// date, APR, rate type, credit limit, opening deposit, certificate term, auto-renew).
//
// Tables of their own beside cdm_party, cdm_loan and cdm_deposit_account, which don't change. Every draw
// is unit() on salts 2601 to 2699, so nothing already generated moves. Numbers agree with what DI already
// shows: the primary account's number is the member number DI derives (10,004,520 + party id), and every
// loan and share number ends in the four digits DI shows for it (its id mod 10,000).
import { AS_OF, unit } from './generate.ts';

export const ESP_ACCOUNT_DDL = [
  `CREATE TABLE cdm_account (account_number VARCHAR(12) PRIMARY KEY, primary_party_id INT NOT NULL, account_type VARCHAR(20) NOT NULL, branch_id INT NOT NULL, opened_by_employee_id INT NULL, open_date DATE NOT NULL, close_date DATE NULL, estatements TINYINT NOT NULL, e_notice TINYINT NOT NULL, is_rep_payee TINYINT NOT NULL, KEY ix_acct_party (primary_party_id))`,
  `CREATE TABLE cdm_account_holding (account_kind VARCHAR(8) NOT NULL, account_id INT NOT NULL, account_number VARCHAR(12) NOT NULL, suffix VARCHAR(4) NOT NULL, holding_number VARCHAR(12) NOT NULL, PRIMARY KEY (account_kind, account_id), KEY ix_holding_account (account_number), UNIQUE KEY ux_holding_number (holding_number))`,
  `CREATE TABLE cdm_household (household_id INT PRIMARY KEY, name VARCHAR(80) NOT NULL, head_party_id INT NOT NULL, members INT NOT NULL, street VARCHAR(80) NOT NULL, city VARCHAR(40) NOT NULL, state CHAR(2) NOT NULL, zip CHAR(5) NOT NULL, formed_date DATE NOT NULL)`,
  `CREATE TABLE cdm_party_detail (party_id INT PRIMARY KEY, member_number VARCHAR(12) NOT NULL, middle_name VARCHAR(40) NULL, preferred_name VARCHAR(40) NULL, tin_type VARCHAR(8) NOT NULL, ssn_last4 CHAR(4) NOT NULL, language VARCHAR(20) NOT NULL, deceased_date DATE NULL, marketing_opt_out TINYINT NOT NULL, UNIQUE KEY ux_detail_number (member_number))`,
  `CREATE TABLE cdm_party_address (party_id INT PRIMARY KEY, street VARCHAR(80) NOT NULL, street2 VARCHAR(40) NULL, city VARCHAR(40) NOT NULL, state CHAR(2) NOT NULL, zip CHAR(5) NOT NULL, KEY ix_addr_zip (zip))`,
  `CREATE TABLE cdm_loan_terms (loan_id INT PRIMARY KEY, structure VARCHAR(12) NOT NULL, rate_type VARCHAR(10) NOT NULL, apr DECIMAL(6,3) NOT NULL, payment_amount DECIMAL(12,2) NOT NULL, payment_due_date DATE NULL, next_rate_change DATE NULL, credit_limit DECIMAL(14,2) NULL, dti DECIMAL(4,2) NULL, pmi TINYINT NOT NULL, escrow_balance DECIMAL(12,2) NULL)`,
  `CREATE TABLE cdm_deposit_terms (account_id INT PRIMARY KEY, original_amount DECIMAL(14,2) NOT NULL, term_months SMALLINT NULL, auto_renew TINYINT NULL)`,
];

export const ESP_ACCOUNT_COLUMNS = {
  cdm_account: ['account_number', 'primary_party_id', 'account_type', 'branch_id', 'opened_by_employee_id', 'open_date', 'close_date', 'estatements', 'e_notice', 'is_rep_payee'],
  cdm_account_holding: ['account_kind', 'account_id', 'account_number', 'suffix', 'holding_number'],
  cdm_household: ['household_id', 'name', 'head_party_id', 'members', 'street', 'city', 'state', 'zip', 'formed_date'],
  cdm_party_detail: ['party_id', 'member_number', 'middle_name', 'preferred_name', 'tin_type', 'ssn_last4', 'language', 'deceased_date', 'marketing_opt_out'],
  cdm_party_address: ['party_id', 'street', 'street2', 'city', 'state', 'zip'],
  cdm_loan_terms: ['loan_id', 'structure', 'rate_type', 'apr', 'payment_amount', 'payment_due_date', 'next_rate_change', 'credit_limit', 'dti', 'pmi', 'escrow_balance'],
  cdm_deposit_terms: ['account_id', 'original_amount', 'term_months', 'auto_renew'],
} as const;

/** The member or customer number; the same formula as di-core's memberNumber, which every screen shows. */
export const memberNumberOf = (partyId: number) => String(10_004_520 + partyId);
/** A loan or share's full number: kind, branch, then the id, so its last four are what DI shows today. */
export const holdingNumberOf = (kind: 'loan' | 'deposit', branchId: number, id: number) => `${kind === 'loan' ? '7' : '2'}${String(branchId).padStart(2, '0')}${String(id).padStart(7, '0')}`;

// Places: fictional towns around each branch, in the state each demo institution is in.
const TOWNS: Record<'credit_union' | 'bank', { state: string; branches: [string, string][][] }> = {
  credit_union: {
    state: 'OR',
    branches: [
      [['Westport', '97301'], ['Cedar Hills', '97305']],
      [['Northgate', '97310'], ['Alder Creek', '97313']],
      [['Riverside', '97320'], ['Millbrook', '97322']],
      [['Lakeshore', '97330'], ['Fern Bay', '97334']],
      [['Harborview', '97340'], ['Harborview', '97342']],
      [['Eastgate', '97350'], ['Pine Ridge', '97355']],
    ],
  },
  bank: {
    state: 'WA',
    branches: [
      [['Port Harbor', '98501'], ['Seabrook', '98504']],
      [['Bayview', '98510'], ['Seabrook', '98504']],
      [['Metro City', '98520'], ['Lakewood Park', '98524']],
      [['Westfield', '98530'], ['Metro City', '98521']],
      [['Pinecrest', '98540'], ['Elk Valley', '98545']],
    ],
  },
};
const STREETS = ['Maple', 'Oak', 'Cedar', 'Pine', 'Elm', 'Birch', 'Willow', 'Spruce', 'Harbor', 'Lake', 'Hill', 'River', 'Park', 'Sunset', 'Meadow', 'Forest', 'Ridge', 'Valley', 'Bay', 'Mill', 'Church', 'Main', 'Washington', 'Lincoln', 'Jefferson', 'Madison', 'Franklin', 'Highland', 'Orchard', 'Vista'];
const SUFFIXES = ['St', 'Ave', 'Rd', 'Dr', 'Ln', 'Way', 'Ct', 'Pl', 'Blvd', 'Ter'];
const MIDDLE = ['A.', 'B.', 'C.', 'D.', 'E.', 'F.', 'G.', 'H.', 'J.', 'K.', 'L.', 'M.', 'N.', 'P.', 'R.', 'S.', 'T.', 'W.', 'Ann', 'Lee', 'Marie', 'James', 'Lynn', 'Ray', 'Rose', 'Jean'];
const NICKNAMES: Record<string, string> = { William: 'Bill', Robert: 'Bob', Richard: 'Rick', James: 'Jim', Michael: 'Mike', Elizabeth: 'Liz', Katherine: 'Kate', Margaret: 'Maggie', Jennifer: 'Jen', Christopher: 'Chris', Daniel: 'Dan', Matthew: 'Matt', Anthony: 'Tony', Joseph: 'Joe', Thomas: 'Tom', Patricia: 'Pat', Susan: 'Sue', Samuel: 'Sam', Benjamin: 'Ben', Alexander: 'Alex', Nicholas: 'Nick', Jonathan: 'Jon', Rebecca: 'Becky', Deborah: 'Debbie', Victoria: 'Tori', Suzanne: 'Suzy' };
const LANGUAGES: [string, number][] = [['English', 0.885], ['Spanish', 0.08], ['Vietnamese', 0.012], ['Chinese', 0.01], ['Russian', 0.006], ['Tagalog', 0.004], ['Korean', 0.003]];
const COMMERCIAL = new Set(['Commercial Real Estate', 'Commercial & Industrial', 'Business']);

const DAY = 86_400_000;
const day = (v: unknown) => (v instanceof Date ? v.toISOString() : String(v)).slice(0, 10);
const addDays = (iso: string, n: number) => new Date(Date.parse(`${iso}T00:00:00Z`) + n * DAY).toISOString().slice(0, 10);
const months = (from: string, to: string) => (Number(to.slice(0, 4)) - Number(from.slice(0, 4))) * 12 + Number(to.slice(5, 7)) - Number(from.slice(5, 7));
const pick = <T>(xs: readonly T[], u: number) => xs[Math.min(xs.length - 1, Math.floor(u * xs.length))]!;
const weighted = (xs: [string, number][], u: number) => {
  let acc = 0;
  for (const [v, w] of xs) if (u < (acc += w)) return v;
  return xs[0]![0];
};
const round2 = (n: number) => Math.round(n * 100) / 100;

export interface AccountInputs {
  institutionType: 'credit_union' | 'bank';
  /** cdm_party rows: id, first, last, birth, join, branch, segment, household, is_member. */
  parties: unknown[][];
  /** cdm_loan rows: id 0, party 1, branch 2, category 4, open 6, close 7, charge-off 8, original 9, balance 10, rate 11, days delinquent 12, score 13, ltv 14, term 15. */
  loans: unknown[][];
  /** cdm_deposit_account rows: id 0, party 1, branch 2, category 3, open 4, close 5, maturity 6, balance 7, rate 8. */
  deposits: unknown[][];
  /** cdm_account_owner rows: kind, account id, party, role. */
  owners: unknown[][];
  /** cdm_account_origination rows: kind, account id, opened-by employee, originating branch, channel. */
  origination: unknown[][];
  /** cdm_account_product rows (kind, account id, product id) and the loan products (id, name, category, amount, count, secured, revolving). */
  accountProducts: unknown[][];
  loanProducts: unknown[][];
  /** cdm_digital_usage rows: party 0, ..., estatements_since 4. */
  digital: unknown[][];
}

export function generateAccounts(x: AccountInputs) {
  const bank = x.institutionType === 'bank';
  const places = TOWNS[x.institutionType];
  const productOf = new Map(x.accountProducts.map((r) => [`${r[0]}|${r[1]}`, String(r[2])]));
  const revolvingProduct = new Set(x.loanProducts.filter((p) => Number(p[6]) === 1).map((p) => String(p[0])));
  const estatements = new Set(x.digital.filter((d) => d[4] !== null && d[4] !== undefined).map((d) => Number(d[0])));
  const openedBy = new Map(x.origination.map((o) => [`${o[0]}|${o[1]}`, o[2] === null ? null : Number(o[2])]));
  const jointOn = new Set(x.owners.filter((o) => o[0] === 'deposit' && o[3] === 'Joint').map((o) => Number(o[1])));
  const partyById = new Map(x.parties.map((p) => [Number(p[0]), p]));

  // ---- Addresses and households --------------------------------------------------------------------
  const addressFor = (id: number, branch: number) => {
    const towns = places.branches[(branch - 1) % places.branches.length]!;
    // A few people live near another branch.
    const away = unit(id, 2601) < 0.04;
    const [city, zip] = away ? pick(places.branches.flat(), unit(id, 2602)) : pick(towns, unit(id, 2603));
    const street = `${100 + Math.floor(unit(id, 2604) * 19_800)} ${pick(STREETS, unit(id, 2605))} ${pick(SUFFIXES, unit(id, 2606))}`;
    const street2 = unit(id, 2607) < 0.07 ? `Apt ${1 + Math.floor(unit(id, 2608) * 340)}` : null;
    return { street, street2, city, state: places.state, zip };
  };
  const byHousehold = new Map<number, unknown[][]>();
  for (const p of x.parties) (byHousehold.get(Number(p[7])) ?? byHousehold.set(Number(p[7]), []).get(Number(p[7]))!).push(p);
  const addresses = new Map<number, ReturnType<typeof addressFor>>();
  const households: unknown[][] = [];
  for (const [hh, members] of [...byHousehold].sort((a, b) => a[0] - b[0])) {
    const head = members.reduce((a, b) => (Number(a[0]) <= Number(b[0]) ? a : b));
    const home = addressFor(Number(head[0]), Number(head[5]));
    for (const m of members) {
      const id = Number(m[0]);
      // Most of a household lives at the head's address; some (grown children, partners) don't yet.
      addresses.set(id, id === Number(head[0]) || unit(id, 2609) < 0.86 ? home : addressFor(id, Number(m[5])));
    }
    const formed = members.map((m) => day(m[4])).sort()[0]!;
    households.push([hh, `${String(head[2])} household`, Number(head[0]), members.length, home.street, home.city, home.state, home.zip, formed]);
  }
  const partyAddresses = x.parties.map((p) => {
    const a = addresses.get(Number(p[0]))!;
    return [Number(p[0]), a.street, a.street2, a.city, a.state, a.zip];
  });

  // ---- Customer details ----------------------------------------------------------------------------
  const details = x.parties.map((p) => {
    const id = Number(p[0]);
    const first = String(p[1]);
    const age = (Date.parse(`${AS_OF}T00:00:00Z`) - Date.parse(`${day(p[3])}T00:00:00Z`)) / (365.25 * DAY);
    // About one in a hundred people over 70 died in the last 18 months; their accounts stay open until the estate settles.
    const deceased = age >= 70 && unit(id, 2611) < 0.012 ? addDays(AS_OF, -Math.floor(unit(id, 2612) * 540) - 1) : null;
    return [
      id,
      memberNumberOf(id),
      unit(id, 2613) < 0.62 ? pick(MIDDLE, unit(id, 2614)) : null,
      NICKNAMES[first] && unit(id, 2615) < 0.35 ? NICKNAMES[first] : null,
      unit(id, 2616) < 0.015 ? 'ITIN' : 'SSN',
      String(Math.floor(unit(id, 2617) * 10_000)).padStart(4, '0'),
      weighted(LANGUAGES, unit(id, 2618)),
      deceased,
      unit(id, 2619) < 0.11 ? 1 : 0,
    ];
  });

  // ---- Accounts and holdings -----------------------------------------------------------------------
  type Holding = { kind: 'loan' | 'deposit'; id: number; party: number; branch: number; open: string; closed: string | null; label: string };
  const holdings: Holding[] = [
    ...x.loans.map((l) => ({ kind: 'loan' as const, id: Number(l[0]), party: Number(l[1]), branch: Number(l[2]), open: day(l[6]), closed: l[7] ? day(l[7]) : l[8] ? day(l[8]) : null, label: String(l[4]) })),
    ...x.deposits.map((d) => ({ kind: 'deposit' as const, id: Number(d[0]), party: Number(d[1]), branch: Number(d[2]), open: day(d[4]), closed: d[5] ? day(d[5]) : null, label: String(d[3]) })),
  ];
  // Which account each holding sits under: a business account for commercial loans and business
  // checking, a trust account for some older people's certificates, else the person's own.
  const accountOf = (h: Holding) => {
    const product = productOf.get(`${h.kind}|${h.id}`) ?? '';
    if ((h.kind === 'loan' && COMMERCIAL.has(h.label)) || product === 'CHK-BUS') return { number: `5${String(h.party).padStart(7, '0')}`, type: 'Business' };
    const p = partyById.get(h.party);
    const age = p ? (Date.parse(`${AS_OF}T00:00:00Z`) - Date.parse(`${day(p[3])}T00:00:00Z`)) / (365.25 * DAY) : 0;
    if (h.kind === 'deposit' && h.label.startsWith('Certificates') && age >= 60 && unit(h.party, 2621) < 0.08) return { number: `6${String(h.party).padStart(7, '0')}`, type: 'Trust' };
    return { number: memberNumberOf(h.party), type: 'Own' };
  };
  const accounts = new Map<string, { number: string; party: number; type: string; holdings: Holding[] }>();
  const holdingRows: unknown[][] = [];
  for (const h of holdings) {
    const a = accountOf(h);
    const acct = accounts.get(a.number) ?? accounts.set(a.number, { number: a.number, party: h.party, type: a.type, holdings: [] }).get(a.number)!;
    acct.holdings.push(h);
  }
  // Every member has their own account, even one who holds nothing under it today.
  for (const p of x.parties) {
    const n = memberNumberOf(Number(p[0]));
    if (!accounts.has(n) && Number(p[8]) === 1) accounts.set(n, { number: n, party: Number(p[0]), type: 'Own', holdings: [] });
  }
  const accountRows: unknown[][] = [];
  for (const a of [...accounts.values()].sort((u, v) => (u.number < v.number ? -1 : 1))) {
    const p = partyById.get(a.party)!;
    const sorted = [...a.holdings].sort((u, v) => (u.open < v.open ? -1 : u.open > v.open ? 1 : u.id - v.id));
    // Suffixes as a credit union numbers them: shares S00 up (the first, the membership share), loans L01 up.
    let s = 0;
    let l = 1;
    for (const h of sorted) {
      const suffix = h.kind === 'deposit' ? `S${String(s++).padStart(2, '0')}` : `L${String(l++).padStart(2, '0')}`;
      holdingRows.push([h.kind, h.id, a.number, suffix, holdingNumberOf(h.kind, h.branch, h.id)]);
    }
    const own = a.type === 'Own';
    const first = sorted[0];
    const type = own ? (a.holdings.some((h) => h.kind === 'deposit' && jointOn.has(h.id)) ? 'Joint' : 'Individual') : a.type;
    const open = own ? day(p[4]) : first!.open;
    const allClosed = !own && a.holdings.every((h) => h.closed);
    const close = allClosed ? a.holdings.map((h) => h.closed!).sort().at(-1)! : null;
    const branch = own ? Number(p[5]) : first!.branch;
    const by = first ? (openedBy.get(`${first.kind}|${first.id}`) ?? null) : null;
    const age = (Date.parse(`${AS_OF}T00:00:00Z`) - Date.parse(`${day(p[3])}T00:00:00Z`)) / (365.25 * DAY);
    const estmt = estatements.has(a.party) ? 1 : 0;
    accountRows.push([a.number, a.party, type, branch, by, open, close, estmt, estmt && unit(a.party, 2622) < 0.75 ? 1 : 0, own && age >= 75 && unit(a.party, 2623) < 0.04 ? 1 : 0]);
  }

  // ---- Loan terms ----------------------------------------------------------------------------------
  const nextQuarter = (() => {
    const y = Number(AS_OF.slice(0, 4));
    const m = Number(AS_OF.slice(5, 7));
    const q = Math.floor((m - 1) / 3) + 1;
    return q === 4 ? `${y + 1}-01-01` : `${y}-${String(q * 3 + 1).padStart(2, '0')}-01`;
  })();
  const loanTerms = x.loans.map((row) => {
    const id = Number(row[0]);
    const cat = String(row[4]);
    const open = day(row[6]);
    const done = Boolean(row[7] || row[8]);
    const original = Number(row[9]);
    const balance = Number(row[10]);
    const rate = Number(row[11]);
    const late = Number(row[12]);
    const score = row[13] === null || row[13] === undefined ? null : Number(row[13]);
    const ltv = row[14] === null || row[14] === undefined ? null : Number(row[14]);
    const term = row[15] === null || row[15] === undefined ? null : Number(row[15]);
    const product = productOf.get(`loan|${id}`) ?? '';
    const line = cat === 'Credit Card' || cat === 'HELOC' || revolvingProduct.has(product);
    const card = cat === 'Credit Card';
    const commercial = COMMERCIAL.has(cat);
    const rateType = line || (commercial && unit(id, 2631) < 0.4) ? 'Variable' : 'Fixed';
    const apr = Math.round((rate + (cat === 'Mortgage' ? 0.11 : cat === 'Auto' ? 0.04 : 0)) * 1000) / 1000;
    const util = 0.25 + unit(id, 2632) * 0.6;
    // Lines are set in round amounts: the amount first approved, rounded up to $500, or more if drawn further.
    const limit = line ? Math.max(Math.ceil(original / 500) * 500, Math.ceil(balance / util / 500) * 500, card ? 500 : 5_000) : null;
    let payment = 0;
    if (!done && balance > 0) {
      if (card) payment = Math.max(25, Math.round(balance * 0.03));
      else if (line) payment = Math.max(50, Math.round(balance * (rate / 1200 + 0.01)));
      else {
        const n = Math.max(1, (term ?? 60) - Math.max(0, months(open, AS_OF)));
        const r = rate / 1200;
        payment = r ? (balance * r) / (1 - Math.pow(1 + r, -n)) : balance / n;
      }
    }
    // A late loan's due date is the oldest payment it missed, so it agrees with days delinquent.
    const dueDay = Math.min(28, Number(open.slice(8, 10)));
    const nextDue = (() => {
      const [y, m] = [Number(AS_OF.slice(0, 4)), Number(AS_OF.slice(5, 7))];
      const thisMonth = `${y}-${String(m).padStart(2, '0')}-${String(dueDay).padStart(2, '0')}`;
      if (thisMonth > AS_OF) return thisMonth;
      return m === 12 ? `${y + 1}-01-${String(dueDay).padStart(2, '0')}` : `${y}-${String(m + 1).padStart(2, '0')}-${String(dueDay).padStart(2, '0')}`;
    })();
    const due = done || payment === 0 ? null : late > 0 ? addDays(AS_OF, -late) : nextDue;
    const dti = commercial || score === null ? null : Math.round(Math.min(0.5, Math.max(0.08, 0.45 - ((score - 580) / 270) * 0.25 + (unit(id, 2633) - 0.5) * 0.12)) * 100) / 100;
    const escrow = cat === 'Mortgage' && !done && unit(id, 2634) < 0.85 ? round2(((original * 0.015) / 12) * (2 + 4 * unit(id, 2635))) : null;
    return [id, line ? 'Line' : 'Amortizing', rateType, apr, round2(payment), due, rateType === 'Variable' && !card && !done ? nextQuarter : null, limit, dti, cat === 'Mortgage' && ltv !== null && ltv > 80 ? 1 : 0, escrow];
  });

  // ---- Deposit terms -------------------------------------------------------------------------------
  const depositTerms = x.deposits.map((d) => {
    const id = Number(d[0]);
    const cat = String(d[3]);
    const balance = Number(d[7]);
    const rate = Number(d[8]);
    const product = productOf.get(`deposit|${id}`) ?? '';
    const term = /-(\d+)$/.exec(product)?.[1];
    const certificate = /^(CERT|CD)-/.test(product) || cat.startsWith('Certificates');
    const years = Math.max(0, (Date.parse(`${AS_OF}T00:00:00Z`) - Date.parse(`${day(d[4])}T00:00:00Z`)) / (365.25 * DAY));
    const original = certificate
      ? balance / (1 + (rate / 100) * Math.min(years, Number(term ?? 12) / 12))
      : cat === 'IRA'
        ? 1_000 + unit(id, 2641) * 6_000
        : cat === 'Money Market'
          ? Math.min(Math.max(balance, 2_500), 2_500 + unit(id, 2642) * 22_500)
          : 25 + unit(id, 2643) * 975;
    return [id, round2(original), certificate && term ? Number(term) : null, certificate ? (unit(id, 2644) < 0.72 ? 1 : 0) : null];
  });

  return { accounts: accountRows, holdings: holdingRows, households, details, addresses: partyAddresses, loanTerms, depositTerms };
}
