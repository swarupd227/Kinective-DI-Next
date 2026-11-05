// Deterministic synthetic tenants (spec 27.2: golden questions run against a fixed synthetic test
// tenant with a credit union and a bank configuration). Every name, account and figure is fictional.
// The same seed always produces the same rows, so expected answers can be versioned with the suite.

export const AS_OF = '2026-10-25';
export const BUILD = { buildId: 'bld_20261026', completedAt: '2026-10-26 04:10:00' };
/** Month-ends kept in history: 18 months up to the last complete month before the build. */
export const HISTORY_MONTHS = 18;
/** Annual growth the month-end history follows: loans, and shares and deposits. */
const LOAN_GROWTH = 0.03;
const SHARE_GROWTH = 0.05;

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

// Names are drawn uniformly, so the pool sets how often a full name repeats. 300 first and 271 last
// names give about 81,000 combinations: in 46,000 members a name repeats a handful of times at most,
// as in a real membership, instead of 720 combinations repeating up to 124 times.
const FIRST = [
  'Aaron', 'Abigail', 'Adam', 'Adrian', 'Aisha', 'Alan', 'Albert', 'Alejandro', 'Alex', 'Alexis',
  'Alice', 'Alicia', 'Allison', 'Amanda', 'Amara', 'Amber', 'Amir', 'Amy', 'Ana', 'Andre',
  'Andrea', 'Andrew', 'Angela', 'Anita', 'Ann', 'Anthony', 'Antonio', 'Arjun', 'Ashley', 'Audrey',
  'Austin', 'Barbara', 'Ben', 'Benjamin', 'Beth', 'Bianca', 'Brandon', 'Brenda', 'Brian',
  'Brittany', 'Bruce', 'Bryan', 'Caleb', 'Cameron', 'Camila', 'Carl', 'Carla', 'Carlos', 'Carmen',
  'Carol', 'Caroline', 'Carter', 'Catherine', 'Cecilia', 'Charles', 'Charlotte', 'Chelsea',
  'Chloe', 'Chris', 'Christina', 'Christopher', 'Claire', 'Clara', 'Colin', 'Connor', 'Craig',
  'Crystal', 'Cynthia', 'Daniel', 'Danielle', 'Darius', 'David', 'Deborah', 'Denise', 'Derek',
  'Diana', 'Diego', 'Dominic', 'Donald', 'Donna', 'Dorothy', 'Dylan', 'Edward', 'Eileen', 'Elena',
  'Elijah', 'Elizabeth', 'Ella', 'Emily', 'Emma', 'Eric', 'Erica', 'Erin', 'Esther', 'Ethan',
  'Eugene', 'Evan', 'Evelyn', 'Farah', 'Fatima', 'Felix', 'Fiona', 'Frances', 'Frank', 'Gabriel',
  'Gabriela', 'Gary', 'George', 'Gerald', 'Gina', 'Gloria', 'Grace', 'Gregory', 'Hailey', 'Hannah',
  'Harold', 'Harper', 'Hassan', 'Heather', 'Helen', 'Henry', 'Hiroshi', 'Holly', 'Hugo', 'Ian',
  'Imani', 'Irene', 'Isaac', 'Isabel', 'Isabella', 'Ivan', 'Jack', 'Jacob', 'Jacqueline', 'Jake',
  'Jamal', 'James', 'Jamie', 'Janet', 'Janice', 'Jasmine', 'Jason', 'Javier', 'Jean', 'Jeffrey',
  'Jennifer', 'Jeremy', 'Jerome', 'Jessica', 'Joan', 'Joel', 'John', 'Jonathan', 'Jordan', 'Jorge',
  'Jose', 'Joseph', 'Joshua', 'Joyce', 'Juan', 'Judith', 'Julia', 'Julian', 'Justin', 'Karen',
  'Katherine', 'Keith', 'Kelly', 'Kenji', 'Kenneth', 'Kevin', 'Kimberly', 'Kofi', 'Kyle', 'Laila',
  'Lara', 'Laura', 'Lauren', 'Lawrence', 'Leah', 'Lena', 'Leon', 'Leticia', 'Liam', 'Lillian',
  'Linda', 'Lisa', 'Logan', 'Lucas', 'Lucia', 'Luis', 'Luke', 'Madeline', 'Malik', 'Mara',
  'Marcus', 'Margaret', 'Maria', 'Marie', 'Mario', 'Mark', 'Martha', 'Martin', 'Mary', 'Mason',
  'Mateo', 'Matthew', 'Maya', 'Megan', 'Mei', 'Melissa', 'Michael', 'Michelle', 'Miguel', 'Mila',
  'Monica', 'Nadia', 'Nancy', 'Naomi', 'Natalie', 'Nathan', 'Nicholas', 'Nicole', 'Noah', 'Nora',
  'Olivia', 'Omar', 'Oscar', 'Owen', 'Pamela', 'Patricia', 'Patrick', 'Paul', 'Paula', 'Peter',
  'Philip', 'Priya', 'Rachel', 'Rafael', 'Rahul', 'Ramon', 'Raymond', 'Rebecca', 'Reggie', 'Renee',
  'Ricardo', 'Richard', 'Rita', 'Robert', 'Roger', 'Ronald', 'Rosa', 'Ruby', 'Russell', 'Ruth',
  'Ryan', 'Samantha', 'Samuel', 'Sandra', 'Sara', 'Scott', 'Sean', 'Sergio', 'Sharon', 'Simone',
  'Stephanie', 'Stephen', 'Steven', 'Susan', 'Suzanne', 'Tamara', 'Teresa', 'Terrence', 'Theresa',
  'Thomas', 'Tiffany', 'Timothy', 'Tina', 'Tom', 'Travis', 'Trevor', 'Tyler', 'Valerie', 'Vanessa',
  'Victor', 'Victoria', 'Vincent', 'Virginia', 'Walter', 'Wanda', 'Wayne', 'Wei', 'Wesley',
  'William', 'Xavier', 'Yasmin', 'Yolanda', 'Yusuf', 'Zachary', 'Zoe',
];
const LAST = [
  'Abbott', 'Acosta', 'Adams', 'Adeyemi', 'Aguilar', 'Ahmed', 'Alexander', 'Ali', 'Allen',
  'Alvarez', 'Anderson', 'Andrews', 'Armstrong', 'Arnold', 'Bailey', 'Baker', 'Banerjee', 'Barnes',
  'Bell', 'Bennett', 'Berg', 'Bishop', 'Black', 'Boyd', 'Bradley', 'Brennan', 'Brooks', 'Brown',
  'Bryant', 'Burke', 'Burns', 'Butler', 'Byrne', 'Caldwell', 'Campbell', 'Carlson', 'Carpenter',
  'Carroll', 'Carter', 'Castillo', 'Castro', 'Chan', 'Chang', 'Chapman', 'Chavez', 'Chen', 'Cho',
  'Clark', 'Cohen', 'Cole', 'Coleman', 'Collins', 'Cook', 'Cooper', 'Cruz', 'Cunningham',
  'Daniels', 'Davidson', 'Davis', 'Delgado', 'Diaz', 'Dixon', 'Dominguez', 'Doyle', 'Duncan',
  'Dunn', 'Edwards', 'Elliott', 'Ellis', 'Evans', 'Farrell', 'Ferguson', 'Fernandez', 'Fischer',
  'Fisher', 'Fitzgerald', 'Fleming', 'Flores', 'Foster', 'Fox', 'Francis', 'Freeman', 'Fuller',
  'Gallagher', 'Garcia', 'Gardner', 'Gibson', 'Gill', 'Gomez', 'Gonzalez', 'Goodwin', 'Gordon',
  'Graham', 'Grant', 'Gray', 'Green', 'Greene', 'Griffin', 'Gupta', 'Gutierrez', 'Haddad', 'Hall',
  'Hamilton', 'Hansen', 'Harper', 'Harris', 'Hart', 'Hayes', 'Henderson', 'Hernandez', 'Herrera',
  'Hill', 'Hoffman', 'Holland', 'Holmes', 'Howard', 'Hughes', 'Hunt', 'Hussain', 'Ibrahim',
  'Jackson', 'Jacobson', 'James', 'Jenkins', 'Jensen', 'Johnson', 'Jones', 'Jordan', 'Joseph',
  'Kaur', 'Keller', 'Kelly', 'Kennedy', 'Khan', 'Kim', 'Knight', 'Kowalski', 'Kumar', 'Lam',
  'Larsen', 'Lawrence', 'Lawson', 'Le', 'Lewis', 'Li', 'Lindqvist', 'Little', 'Liu', 'Long',
  'Lopez', 'Lynch', 'Mahoney', 'Malik', 'Marshall', 'Martin', 'Martinez', 'Mason', 'Matthews',
  'Mendoza', 'Meyer', 'Miller', 'Mills', 'Mitchell', 'Molina', 'Moore', 'Morales', 'Moreau',
  'Moreno', 'Morgan', 'Morris', 'Murphy', 'Murray', 'Myers', 'Nakamura', 'Nelson', 'Newman',
  'Nguyen', 'Nichols', 'Novak', 'Obi', 'Okafor', 'Oliver', 'Olsen', 'Ortega', 'Ortiz', 'Owens',
  'Palmer', 'Park', 'Parker', 'Patel', 'Patterson', 'Payne', 'Perez', 'Perry', 'Peters',
  'Peterson', 'Phillips', 'Pierce', 'Porter', 'Powell', 'Price', 'Quinn', 'Ramirez', 'Ramos',
  'Reed', 'Reyes', 'Reynolds', 'Rice', 'Richardson', 'Riley', 'Rivera', 'Roberts', 'Robinson',
  'Rodriguez', 'Rogers', 'Romero', 'Rose', 'Ross', 'Ruiz', 'Russell', 'Ryan', 'Salazar', 'Sanchez',
  'Sanders', 'Santos', 'Schmidt', 'Schneider', 'Scott', 'Shah', 'Sharma', 'Shaw', 'Silva',
  'Simmons', 'Simpson', 'Singh', 'Sullivan', 'Sutton', 'Tanaka', 'Taylor', 'Thomas', 'Thompson',
  'Torres', 'Tran', 'Tucker', 'Turner', 'Vargas', 'Vasquez', 'Vaughn', 'Wagner', 'Walker',
  'Wallace', 'Walsh', 'Wang', 'Ward', 'Warren', 'Washington', 'Watson', 'Weber', 'Wells', 'West',
  'Wheeler', 'White', 'Williams', 'Wilson', 'Wood', 'Wright', 'Wu', 'Yamamoto', 'Yang', 'Young',
  'Zhang',
];

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
  /** Month-end balance by delinquency status, branch, category, channel and vintage. */
  histDq: unknown[][];
  /** Month-end moves from last month's status to this month's, for roll rates. */
  histRoll: unknown[][];
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

/** People who sign in to the demo. A member who shares a staff member's name is confusing, so none does. */
const PERSONA_NAMES = ['Dana Lee', 'Priya Shah', 'Sam Taylor', 'Marcus Reed', 'Ana Ruiz', 'Sofia Ruiz', 'Tom Walsh', 'Elena Ortiz'];

function nameDemoMembers(rows: unknown[][], staff: string[]) {
  const reserved = new Set([...DEMO_MEMBERS.map(([f, l]) => `${f} ${l}`), ...PERSONA_NAMES, ...staff]);
  const owner = new Map<string, number>([['Suzanne Jackson', 1]]);
  for (const [first, last, branch] of DEMO_MEMBERS.slice(1)) {
    const row = rows.find((r) => r[5] === branch + 1 && r[8] === 1 && ![...owner.values()].includes(r[0] as number))!;
    owner.set(`${first} ${last}`, row[0] as number);
    row[1] = first;
    row[2] = last;
  }
  for (const r of rows) {
    const full = `${r[1]} ${r[2]}`;
    let step = 1;
    while (reserved.has(`${r[1]} ${r[2]}`) && owner.get(full) !== r[0]) r[2] = LAST[(LAST.indexOf(String(r[2])) + step++) % LAST.length];
  }
}

/** Days past due for a loan in a status, stable per loan. */
const pastDueDays = (id: number, state: string) =>
  state === '30–59 days' ? 31 + (id % 27) : state === '60–89 days' ? 61 + (id % 27) : state === '90–179 days' ? 91 + (id % 85) : state === '180–359 days' ? 181 + (id % 170) : state === '360+ days' ? 361 + (id % 200) : 0;

/**
 * One month's move in a loan's delinquency status. Monthly roll rates are those of a seasoned consumer
 * book: about half of 30-day loans cure, most 60-day loans roll to 90, and later buckets mostly stay or
 * cure. `a` is the chance a current loan misses a payment, set so the 60+ rate settles at the loan's
 * delinquency rate (60+ settles near 1.35 times a).
 */
function nextStatus(state: string, a: number, u: number) {
  switch (state) {
    case 'Current':
      return u < a ? '30–59 days' : 'Current';
    case '30–59 days':
      return u < 0.17 ? '60–89 days' : u < 0.65 ? 'Current' : '30–59 days';
    case '60–89 days':
      return u < 0.55 ? '90–179 days' : u < 0.67 ? 'Current' : u < 0.77 ? '30–59 days' : '60–89 days';
    case '90–179 days':
      return u < 0.18 ? '180–359 days' : u < 0.3 ? 'Current' : '90–179 days';
    case '180–359 days':
      return u < 0.08 ? '360+ days' : u < 0.28 ? 'Current' : '180–359 days';
    default:
      return u < 0.25 ? 'Current' : '360+ days';
  }
}
const SIXTY_PLUS = new Set(['60–89 days', '90–179 days', '180–359 days', '360+ days']);
/** Where a loan starts when history begins, from its draw: about its delinquency rate is 60+. */
const startStatus = (r: number) => (r < 0.065 ? '360+ days' : r < 0.3 ? '180–359 days' : r < 0.7 ? '90–179 days' : r < 1 ? '60–89 days' : r < 2.32 ? '30–59 days' : 'Current');
export const dqBucket = (days: number) => (days >= 360 ? '360+ days' : days >= 180 ? '180–359 days' : days >= 90 ? '90–179 days' : days >= 60 ? '60–89 days' : days >= 30 ? '30–59 days' : 'Current');

export function generate(profile: TenantProfile): GeneratedTenant {
  const r = prng(profile.seed);
  const asOf = new Date(`${AS_OF}T00:00:00Z`);
  const months = monthEnds();
  const branchWeights = profile.branches.map((b, i) => [i, b.weight] as [number, number]);

  const locations = profile.branches.map((b, i) => [i + 1, b.name, b.region, `20${String(2 + i * 3).padStart(2, '0')}-03-01`]);

  const employees: unknown[][] = [];
  profile.branches.forEach((_, bi) => {
    for (let k = 0; k < 6; k++) {
      // Staff have full names, as in a real core. The two draws are the same as when they were initials.
      employees.push([bi * 100 + k + 1, `${FIRST[Math.floor(r() * FIRST.length)]} ${LAST[Math.floor(r() * LAST.length)]}`, k < 2 ? 'Loan officer' : k < 5 ? 'MSR' : 'Branch manager', bi + 1]);
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
  nameDemoMembers(partyRows, employees.map((e) => String(e[1])));

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
  const histDq = new Map<string, number[]>();
  const histRoll = new Map<string, number[]>();
  /** Each loan's last month-end status and balance. */
  const dqState = new Map<number, string>();
  const lastBal = new Map<number, number>();
  // Account-level paths give the mix and the branches, not believable totals: late account opening alone
  // grew shares 13% a year and sank loan-to-share 18 points in 18 months. Each month-end is scaled so loans
  // grow about 3% a year and shares about 5%, with the spring tax-refund bump in shares: loan-to-share
  // eases a point or two a year, as it has at most credit unions since 2023.
  const loansNow = loans.reduce((s, l) => s + balanceAt(l, asOf), 0);
  const depsNow = deps.reduce((s, d) => s + depBalanceAt(d, asOf), 0);
  const yearsBack = (at: Date) => Math.max(0, (asOf.getTime() - at.getTime()) / (365.25 * 86_400_000));
  const loanFactor = months.map((me) => {
    const at = new Date(`${me}T23:59:59Z`);
    const raw = loans.reduce((s, l) => s + balanceAt(l, at), 0);
    return raw ? loansNow / Math.pow(1 + LOAN_GROWTH, yearsBack(at)) / raw : 1;
  });
  const depFactor = months.map((me) => {
    const at = new Date(`${me}T23:59:59Z`);
    const raw = deps.reduce((s, d) => s + depBalanceAt(d, at), 0);
    const spring = [2, 3].includes(at.getUTCMonth()) ? 1.012 : 1;
    return raw ? (depsNow / Math.pow(1 + SHARE_GROWTH, yearsBack(at))) * spring / raw : 1;
  });
  months.forEach((me, mi) => {
    const at = new Date(`${me}T23:59:59Z`);
    const monthStart = new Date(Date.UTC(at.getUTCFullYear(), at.getUTCMonth(), 1));
    const monthsAgo = HISTORY_MONTHS - mi;
    for (const l of loans) {
      const key = `${me}|${l.branch + 1}|${l.cat.category}|${l.indirect ? 1 : 0}`;
      const agg = histLoan.get(key) ?? [0, 0, 0, 0, 0];
      const bal = balanceAt(l, at) * loanFactor[mi]!;
      if (bal > 0) {
        agg[0]! += bal;
        agg[2]! += 1;
      }
      // Month-end delinquency status. Each loan follows its own path, rolling forward, curing or
      // charging off month by month at rates scaled to its branch's and product's delinquency, so the
      // trends (Northgate's rise) hold and roll rates are real. The 60+ balance above comes from it.
      const prev = dqState.get(l.id);
      let state: string | null = null;
      let amount = bal;
      if (bal > 0) {
        const p = dqProb(l, monthsAgo);
        const toChargeOff = l.chargeOff ? monthsBetween(at, l.chargeOff) : 99;
        // Loans that will be charged off are seriously behind in their last months.
        if (toChargeOff <= 3 && toChargeOff >= 0) state = toChargeOff <= 1 ? '180–359 days' : '90–179 days';
        else state = prev ? nextStatus(prev, p / 1.35, unit(l.id, 1000 + mi)) : startStatus(unit(l.id, 0) / p);
        if (SIXTY_PLUS.has(state)) agg[1]! += bal;
      } else if (l.chargeOff && l.chargeOff > monthStart && l.chargeOff <= at && prev) {
        state = 'Charged off';
        amount = lastBal.get(l.id) ?? 0;
      }
      if (state) {
        const dk = `${me}|${l.branch + 1}|${l.cat.category}|${l.indirect ? 1 : 0}|${l.open.getUTCFullYear()}|${state}`;
        const d = histDq.get(dk) ?? [0, 0];
        d[0]! += amount;
        d[1]! += 1;
        histDq.set(dk, d);
        if (prev) {
          const rk = `${me}|${l.branch + 1}|${l.cat.category}|${prev}|${state}`;
          const rr = histRoll.get(rk) ?? [0, 0];
          rr[0]! += amount;
          rr[1]! += 1;
          histRoll.set(rk, rr);
        }
      }
      if (agg[0] || agg[3]) histLoan.set(key, agg);
      if (state && state !== 'Charged off') {
        dqState.set(l.id, state);
        lastBal.set(l.id, bal);
      } else {
        dqState.delete(l.id);
        lastBal.delete(l.id);
      }
      if (l.open >= monthStart && l.open <= at) {
        agg[3]! += l.original;
        agg[4]! += 1;
      }
    }
    for (const d of deps) {
      const bal = depBalanceAt(d, at) * depFactor[mi]!;
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

  // Days past due as of the build: one more step on each loan's path, so today's buckets follow history.
  loans.forEach((l, i) => {
    const row = loanRows[i]!;
    if (!row[10]) return;
    const toChargeOff = l.chargeOff ? monthsBetween(asOf, l.chargeOff) : 99;
    const prev = dqState.get(l.id) ?? startStatus(unit(l.id, 0) / dqProb(l, 0));
    const state = toChargeOff <= 3 && toChargeOff >= 0 ? (toChargeOff <= 1 ? '180–359 days' : '90–179 days') : nextStatus(prev, dqProb(l, 0) / 1.35, unit(l.id, 1000 + HISTORY_MONTHS));
    row[12] = pastDueDays(l.id, state);
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
    histDq: [...histDq].map(([k, v]) => {
      const [me, b, c, i, y, st] = k.split('|');
      return [me, Number(b), c, Number(i), Number(y), st, round2(v[0]!), v[1]];
    }),
    histRoll: [...histRoll].map(([k, v]) => {
      const [me, b, c, f, to] = k.split('|');
      return [me, Number(b), c, f, to, round2(v[0]!), v[1]];
    }),
    histParty: [...histParty].map(([k, v]) => {
      const [me, b] = k.split('|');
      return [me, Number(b), v[0], v[1]];
    }),
  };
}
