// Deterministic synthetic tenants (spec 27.2: golden questions run against a fixed synthetic test
// tenant with a credit union and a bank configuration). Every name, account and figure is fictional.
// The same seed always produces the same rows, so expected answers can be versioned with the suite.

export const AS_OF = '2026-10-25';
export const BUILD = { buildId: 'bld_20261026', completedAt: '2026-10-26 04:10:00' };
/** Month-ends kept in history: 18 months up to the last complete month before the build. */
export const HISTORY_MONTHS = 18;

export interface BranchProfile {
  name: string;
  region: string;
  weight: number;
  /** Multiplier on the delinquency rate; above 1 means a weaker book. */
  dqBias: number;
  /** Extra delinquency in the last three months (the "rising" story Home tells). */
  dqTrend: number;
}

interface LoanMix {
  category: string;
  share: number;
  min: number;
  max: number;
  termMonths: number;
  rate: [number, number];
  indirectShare: number;
  dq60: number;
}

interface DepositMix {
  category: string;
  /** Probability a party holds one. */
  holdRate: number;
  median: number;
  rate: [number, number];
  /** Monthly balance drift: positive means the category grew over the history window. */
  drift: number;
  maturing?: boolean;
}

export interface TenantProfile {
  key: string;
  schema: string;
  name: string;
  institutionType: 'credit_union' | 'bank';
  seed: number;
  members: number;
  loanRate: number;
  targetLoanBalance: number;
  targetDepositBalance: number;
  branches: BranchProfile[];
  loans: LoanMix[];
  deposits: DepositMix[];
  segments: [string, number][];
}

export const TENANTS: TenantProfile[] = [
  {
    key: 'test_cu',
    schema: 'dinext_t_test_cu',
    name: 'Harborview Federal Credit Union',
    institutionType: 'credit_union',
    seed: 20261026,
    members: 46_000,
    loanRate: 0.55,
    targetLoanBalance: 1_212_480_000,
    targetDepositBalance: 1_641_900_000,
    branches: [
      { name: 'Westport', region: 'North', weight: 1.25, dqBias: 0.8, dqTrend: 0 },
      { name: 'Northgate', region: 'North', weight: 0.95, dqBias: 1.35, dqTrend: 0.35 },
      { name: 'Riverside', region: 'South', weight: 0.85, dqBias: 0.95, dqTrend: 0 },
      { name: 'Lakeshore', region: 'South', weight: 0.7, dqBias: 1.0, dqTrend: 0.05 },
      { name: 'Downtown', region: 'Central', weight: 1.3, dqBias: 0.9, dqTrend: 0 },
      { name: 'Eastgate', region: 'Central', weight: 0.55, dqBias: 1.45, dqTrend: 0.45 },
    ],
    loans: [
      { category: 'Auto', share: 0.36, min: 9_000, max: 62_000, termMonths: 66, rate: [4.9, 9.4], indirectShare: 0.55, dq60: 0.009 },
      { category: 'Mortgage', share: 0.12, min: 140_000, max: 640_000, termMonths: 360, rate: [3.1, 7.2], indirectShare: 0, dq60: 0.004 },
      { category: 'HELOC', share: 0.1, min: 20_000, max: 180_000, termMonths: 180, rate: [6.5, 9.5], indirectShare: 0, dq60: 0.005 },
      { category: 'Personal', share: 0.16, min: 2_000, max: 28_000, termMonths: 48, rate: [8.9, 15.9], indirectShare: 0, dq60: 0.018 },
      { category: 'Credit Card', share: 0.22, min: 500, max: 16_000, termMonths: 36, rate: [12.9, 19.9], indirectShare: 0, dq60: 0.014 },
      { category: 'Business', share: 0.04, min: 40_000, max: 450_000, termMonths: 120, rate: [6.0, 9.8], indirectShare: 0, dq60: 0.007 },
    ],
    deposits: [
      { category: 'Share Savings', holdRate: 1, median: 4_200, rate: [0.05, 0.25], drift: -0.004 },
      { category: 'Checking', holdRate: 0.72, median: 3_800, rate: [0, 0.1], drift: 0.001 },
      { category: 'Money Market', holdRate: 0.16, median: 26_000, rate: [1.5, 3.2], drift: -0.002 },
      { category: 'Certificates', holdRate: 0.22, median: 31_000, rate: [3.2, 4.9], drift: 0.011, maturing: true },
      { category: 'IRA', holdRate: 0.08, median: 38_000, rate: [2.5, 4.4], drift: 0.003 },
    ],
    segments: [
      ['Retail', 0.58],
      ['Young Adult', 0.16],
      ['Senior', 0.17],
      ['Small Business', 0.09],
    ],
  },
  {
    key: 'test_bank',
    schema: 'dinext_t_test_bank',
    name: 'Coastal Community Bank',
    institutionType: 'bank',
    seed: 20261027,
    members: 31_000,
    loanRate: 0.42,
    targetLoanBalance: 842_300_000,
    targetDepositBalance: 1_104_800_000,
    branches: [
      { name: 'Harbor', region: 'Coast', weight: 1.3, dqBias: 0.85, dqTrend: 0 },
      { name: 'Bayview', region: 'Coast', weight: 1.0, dqBias: 1.0, dqTrend: 0.1 },
      { name: 'Midtown', region: 'Metro', weight: 1.2, dqBias: 0.95, dqTrend: 0 },
      { name: 'Westfield', region: 'Metro', weight: 0.8, dqBias: 1.25, dqTrend: 0.3 },
      { name: 'Pinecrest', region: 'Inland', weight: 0.6, dqBias: 1.1, dqTrend: 0 },
    ],
    loans: [
      { category: 'Commercial Real Estate', share: 0.1, min: 250_000, max: 2_400_000, termMonths: 240, rate: [5.4, 8.1], indirectShare: 0, dq60: 0.006 },
      { category: 'Commercial & Industrial', share: 0.12, min: 50_000, max: 900_000, termMonths: 84, rate: [6.1, 9.6], indirectShare: 0, dq60: 0.009 },
      { category: 'Mortgage', share: 0.2, min: 150_000, max: 700_000, termMonths: 360, rate: [3.2, 7.1], indirectShare: 0, dq60: 0.004 },
      { category: 'Auto', share: 0.22, min: 10_000, max: 58_000, termMonths: 66, rate: [5.5, 10.2], indirectShare: 0.35, dq60: 0.01 },
      { category: 'Consumer', share: 0.36, min: 1_000, max: 25_000, termMonths: 48, rate: [9.9, 17.9], indirectShare: 0, dq60: 0.016 },
    ],
    deposits: [
      { category: 'Savings', holdRate: 0.8, median: 5_200, rate: [0.05, 0.4], drift: -0.005 },
      { category: 'Checking', holdRate: 0.9, median: 6_400, rate: [0, 0.1], drift: 0.0005 },
      { category: 'Money Market', holdRate: 0.2, median: 41_000, rate: [1.8, 3.6], drift: -0.001 },
      { category: 'Certificates of Deposit', holdRate: 0.24, median: 44_000, rate: [3.4, 5.0], drift: 0.012, maturing: true },
    ],
    segments: [
      ['Consumer', 0.66],
      ['Small Business', 0.22],
      ['Commercial', 0.12],
    ],
  },
];

// ---- deterministic helpers -------------------------------------------------------------------

/** mulberry32: small, fast, deterministic. */
export function prng(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** A stable 0-1 value for a (loan, month) pair, independent of generation order. */
export function unit(a: number, b: number) {
  let h = Math.imul(a ^ 0x9e3779b9, 0x85ebca6b) ^ Math.imul(b + 0x632be5ab, 0xc2b2ae35);
  h ^= h >>> 13;
  h = Math.imul(h, 0x27d4eb2f);
  h ^= h >>> 16;
  return (h >>> 0) / 4294967296;
}

const pick = <T>(r: () => number, items: [T, number][]) => {
  let x = r() * items.reduce((s, [, w]) => s + w, 0);
  for (const [item, w] of items) if ((x -= w) <= 0) return item;
  return items[items.length - 1]![0];
};

const lognormal = (r: () => number, median: number, spread = 0.9) => {
  // Box-Muller
  const z = Math.sqrt(-2 * Math.log(1 - r())) * Math.cos(2 * Math.PI * r());
  return median * Math.exp(spread * z);
};

export const ymd = (d: Date) => d.toISOString().slice(0, 10);
const addMonths = (d: Date, n: number) => new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + n, d.getUTCDate()));
const monthsBetween = (a: Date, b: Date) => (b.getUTCFullYear() - a.getUTCFullYear()) * 12 + (b.getUTCMonth() - a.getUTCMonth()) + (b.getUTCDate() - a.getUTCDate()) / 30;
const round2 = (n: number) => Math.round(n * 100) / 100;

export function monthEnds(): string[] {
  const asOf = new Date(`${AS_OF}T00:00:00Z`);
  const out: string[] = [];
  for (let i = HISTORY_MONTHS; i >= 1; i--) {
    out.push(ymd(new Date(Date.UTC(asOf.getUTCFullYear(), asOf.getUTCMonth() - i + 1, 0))));
  }
  return out;
}

const FIRST = ['Suzanne', 'Robert', 'Ana', 'James', 'Maria', 'David', 'Grace', 'Omar', 'Lena', 'Victor', 'Hannah', 'Kofi', 'Mei', 'Paul', 'Rosa', 'Daniel', 'Priya', 'Marcus', 'Elena', 'Samuel', 'Aisha', 'Tom', 'Julia', 'Kenji', 'Fatima', 'Liam', 'Nora', 'Ivan', 'Chloe', 'Mateo'];
const LAST = ['Jackson', 'Nguyen', 'Patel', 'Garcia', 'Okafor', 'Kim', 'Brown', 'Silva', 'Novak', 'Haddad', 'Lopez', 'Murphy', 'Reed', 'Shah', 'Ortiz', 'Chen', 'Ruiz', 'Taylor', 'Walsh', 'Moreau', 'Lindqvist', 'Adeyemi', 'Kowalski', 'Romero'];

// ---- generation ------------------------------------------------------------------------------

export interface GeneratedTenant {
  profile: TenantProfile;
  locations: unknown[][];
  employees: unknown[][];
  parties: unknown[][];
  loans: unknown[][];
  deposits: unknown[][];
  histLoan: unknown[][];
  histDeposit: unknown[][];
  histParty: unknown[][];
}

/**
 * Demo members keep their names unique, so "Refer Suzanne Jackson" finds one person. Names only:
 * every figure is unchanged. [first, last, branch index]; Suzanne Jackson is party 1 already.
 */
const DEMO_MEMBERS: [string, string, number][] = [
  ['Suzanne', 'Jackson', 0],
  ['Robert', 'Jackson', 1],
  ['Maria', 'Gomez', 4],
  ['Ana', 'Jacobs', 4],
];

function nameDemoMembers(rows: unknown[][]) {
  const reserved = new Set(DEMO_MEMBERS.map(([f, l]) => `${f} ${l}`));
  const owner = new Map<string, number>([['Suzanne Jackson', 1]]);
  for (const [first, last, branch] of DEMO_MEMBERS.slice(1)) {
    const row = rows.find((r) => r[5] === branch + 1 && r[8] === 1 && ![...owner.values()].includes(r[0] as number))!;
    owner.set(`${first} ${last}`, row[0] as number);
    row[1] = first;
    row[2] = last;
  }
  for (const r of rows) {
    const full = `${r[1]} ${r[2]}`;
    if (reserved.has(full) && owner.get(full) !== r[0]) r[2] = LAST[(LAST.indexOf(String(r[2])) + 1) % LAST.length];
  }
}

export function generate(profile: TenantProfile): GeneratedTenant {
  const r = prng(profile.seed);
  const asOf = new Date(`${AS_OF}T00:00:00Z`);
  const months = monthEnds();
  const branchWeights = profile.branches.map((b, i) => [i, b.weight] as [number, number]);

  const locations = profile.branches.map((b, i) => [i + 1, b.name, b.region, `20${String(2 + i * 3).padStart(2, '0')}-03-01`]);

  const employees: unknown[][] = [];
  profile.branches.forEach((_, bi) => {
    for (let k = 0; k < 6; k++) {
      employees.push([bi * 100 + k + 1, `${FIRST[Math.floor(r() * FIRST.length)]![0]}. ${LAST[Math.floor(r() * LAST.length)]}`, k < 2 ? 'Loan officer' : k < 5 ? 'MSR' : 'Branch manager', bi + 1]);
    }
  });

  // The first branch's staff are the people the demos name. Draws above are unchanged.
  for (const [id, name] of [[1, 'Ana Ruiz'], [2, 'Tom Walsh'], [3, 'J. Ortiz'], [4, 'Sofia Ruiz'], [6, 'Marcus Reed']] as const) employees.find((e) => e[0] === id)![1] = name;

  // Members: join dates skew recent; the very first party is the member the demos refer to.
  type Party = { id: number; branch: number; join: Date; member: boolean };
  const parties: Party[] = [];
  const partyRows: unknown[][] = [];
  for (let i = 0; i < profile.members; i++) {
    const branch = i === 0 ? 0 : pick(r, branchWeights);
    // Spread over 25 years with a mild recent skew: steady membership growth of a few percent a year.
    const yearsAgo = 25 * Math.pow(r(), 1.08);
    const join = new Date(asOf.getTime() - yearsAgo * 365.25 * 86_400_000);
    const first = i === 0 ? 'Suzanne' : FIRST[Math.floor(r() * FIRST.length)]!;
    const last = i === 0 ? 'Jackson' : LAST[Math.floor(r() * LAST.length)]!;
    const segment = pick(r, profile.segments);
    const age = segment === 'Young Adult' ? 18 + r() * 8 : segment === 'Senior' ? 62 + r() * 25 : 26 + r() * 36;
    const birth = new Date(asOf.getTime() - age * 365.25 * 86_400_000);
    const member = r() > 0.03;
    parties.push({ id: i + 1, branch, join, member });
    partyRows.push([i + 1, first, last, ymd(birth), ymd(join), branch + 1, segment, Math.floor(i / 1.7) + 1, member ? 1 : 0]);
  }
  nameDemoMembers(partyRows);

  // Loans: open within the last term-and-a-bit, amortise linearly, and close when paid off.
  type Loan = { id: number; party: number; branch: number; cat: LoanMix; indirect: boolean; open: Date; close: Date | null; chargeOff: Date | null; original: number; rate: number };
  const loans: Loan[] = [];
  const loanMix = profile.loans.map((l) => [l, l.share] as [LoanMix, number]);
  let loanId = 1;
  for (const p of parties) {
    let n = r() < profile.loanRate ? 1 + (r() < 0.25 ? 1 : 0) : 0;
    while (n-- > 0) {
      const cat = pick(r, loanMix);
      // Opens spread evenly over the last term and a bit, so the book is near steady state with gentle growth.
      const window = cat.termMonths * 1.15 * 30.4 * 86_400_000;
      const open = new Date(asOf.getTime() - window * Math.pow(r(), 0.96));
      const payoff = addMonths(open, cat.termMonths);
      const close = payoff <= asOf ? payoff : r() < 0.04 ? new Date(open.getTime() + r() * (asOf.getTime() - open.getTime())) : null;
      const chargeOff = !close && r() < 0.006 && monthsBetween(open, asOf) > 8 ? addMonths(open, 6 + Math.floor(r() * Math.max(1, monthsBetween(open, asOf) - 6))) : null;
      const original = cat.min + Math.pow(r(), 1.6) * (cat.max - cat.min);
      loans.push({ id: loanId++, party: p.id, branch: p.branch, cat, indirect: r() < cat.indirectShare, open, close, chargeOff, original, rate: cat.rate[0] + r() * (cat.rate[1] - cat.rate[0]) });
    }
  }

  const balanceAt = (l: Loan, at: Date) => {
    if (at < l.open || (l.close && l.close <= at) || (l.chargeOff && l.chargeOff <= at)) return 0;
    return l.original * Math.max(0, 1 - monthsBetween(l.open, at) / l.cat.termMonths);
  };
  // Scale so the institution lands on its target size (the numbers Home and the fixtures quote).
  const rawTotal = loans.reduce((s, l) => s + balanceAt(l, asOf), 0);
  const loanScale = profile.targetLoanBalance / rawTotal;
  for (const l of loans) l.original *= loanScale;

  /** Probability a loan is 60+ days delinquent in a month; recent months rise in weaker branches. */
  const dqProb = (l: Loan, monthsAgo: number) => {
    const b = profile.branches[l.branch]!;
    const trend = monthsAgo < 3 ? 1 + b.dqTrend * (1 - monthsAgo / 3) : 1;
    return l.cat.dq60 * b.dqBias * trend * (l.indirect ? 1.3 : 1);
  };

  const loanRows = loans.map((l) => {
    const balance = balanceAt(l, asOf);
    const u = unit(l.id, 0);
    const p60 = dqProb(l, 0);
    const days = balance === 0 ? 0 : u < p60 * 0.35 ? 92 + Math.floor(u * 900) % 60 : u < p60 ? 61 + Math.floor(u * 1000) % 28 : u < p60 * 2.2 ? 31 + Math.floor(u * 1000) % 28 : 0;
    const officer = l.branch * 100 + 1 + (l.id % 2);
    return [l.id, l.party, l.branch + 1, officer, l.cat.category, l.indirect ? 1 : 0, ymd(l.open), l.close ? ymd(l.close) : null, l.chargeOff ? ymd(l.chargeOff) : null, round2(l.original), round2(balance), round2(l.rate), days];
  });

  // Deposits: balances drift by category over the history window.
  type Dep = { id: number; party: number; branch: number; mix: DepositMix; open: Date; close: Date | null; balance: number };
  const deps: Dep[] = [];
  let depId = 1;
  for (const p of parties) {
    for (const mix of profile.deposits) {
      if (r() >= mix.holdRate) continue;
      // Accounts other than the primary share open soon after joining, so balances grow steadily, not in a rush.
      const open = new Date(p.join.getTime() + Math.pow(r(), 2.2) * (asOf.getTime() - p.join.getTime()) * (mix.category.startsWith('Share') ? 0 : 1));
      const close = r() < 0.05 ? new Date(open.getTime() + r() * (asOf.getTime() - open.getTime())) : null;
      deps.push({ id: depId++, party: p.id, branch: p.branch, mix, open, close, balance: Math.max(25, lognormal(r, mix.median)) });
    }
  }
  const depBalanceAt = (d: Dep, at: Date) => {
    if (at < d.open || (d.close && d.close <= at)) return 0;
    return d.balance * Math.max(0.2, 1 - d.mix.drift * monthsBetween(at, asOf));
  };
  const rawDep = deps.reduce((s, d) => s + depBalanceAt(d, asOf), 0);
  const depScale = profile.targetDepositBalance / rawDep;
  for (const d of deps) d.balance *= depScale;

  const depositRows = deps.map((d) => {
    const maturity = d.mix.maturing && !d.close ? ymd(new Date(asOf.getTime() + (unit(d.id, 7) * 540 - 20) * 86_400_000)) : null;
    return [d.id, d.party, d.branch + 1, d.mix.category, ymd(d.open), d.close ? ymd(d.close) : null, maturity, round2(depBalanceAt(d, asOf)), round2(d.mix.rate[0] + unit(d.id, 3) * (d.mix.rate[1] - d.mix.rate[0]))];
  });

  // Month-end history (FinBI rollups, spec 14.9).
  const histLoan = new Map<string, number[]>();
  const histDeposit = new Map<string, number[]>();
  const histParty = new Map<string, number[]>();
  months.forEach((me, mi) => {
    const at = new Date(`${me}T23:59:59Z`);
    const monthStart = new Date(Date.UTC(at.getUTCFullYear(), at.getUTCMonth(), 1));
    const monthsAgo = HISTORY_MONTHS - mi;
    for (const l of loans) {
      const key = `${me}|${l.branch + 1}|${l.cat.category}|${l.indirect ? 1 : 0}`;
      const agg = histLoan.get(key) ?? [0, 0, 0, 0, 0];
      const bal = balanceAt(l, at);
      if (bal > 0) {
        agg[0]! += bal;
        agg[2]! += 1;
        // One persistent draw per loan: a loan stays delinquent as the rate rises, so trends are smooth.
        if (unit(l.id, 0) < dqProb(l, monthsAgo)) agg[1]! += bal;
      }
      if (l.open >= monthStart && l.open <= at) {
        agg[3]! += l.original;
        agg[4]! += 1;
      }
      if (agg[0] || agg[3]) histLoan.set(key, agg);
    }
    for (const d of deps) {
      const bal = depBalanceAt(d, at);
      if (bal <= 0) continue;
      const key = `${me}|${d.branch + 1}|${d.mix.category}`;
      const agg = histDeposit.get(key) ?? [0, 0];
      agg[0]! += bal;
      agg[1]! += 1;
      histDeposit.set(key, agg);
    }
    for (const p of parties) {
      if (!p.member || p.join > at) continue;
      const key = `${me}|${p.branch + 1}`;
      const agg = histParty.get(key) ?? [0, 0];
      agg[0]! += 1;
      if (p.join >= monthStart) agg[1]! += 1;
      histParty.set(key, agg);
    }
  });

  return {
    profile,
    locations,
    employees,
    parties: partyRows,
    loans: loanRows,
    deposits: depositRows,
    histLoan: [...histLoan].map(([k, v]) => {
      const [me, b, c, i] = k.split('|');
      return [me, Number(b), c, Number(i), round2(v[0]!), round2(v[1]!), v[2], round2(v[3]!), v[4]];
    }),
    histDeposit: [...histDeposit].map(([k, v]) => {
      const [me, b, c] = k.split('|');
      return [me, Number(b), c, round2(v[0]!), v[1]];
    }),
    histParty: [...histParty].map(([k, v]) => {
      const [me, b] = k.split('|');
      return [me, Number(b), v[0], v[1]];
    }),
  };
}
