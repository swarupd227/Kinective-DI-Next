// Relationship Manager data (spec 17.2): contact details, digital use, attrition scores, product
// suggestions, loan applications, interactions and 30-day account activity. It is generated from
// its own seed after the warehouse rows, so every figure the golden questions use is unchanged.
import { AS_OF, prng, unit, ymd, type GeneratedTenant } from './generate.ts';

export const RELATIONSHIP_DDL = [
  `CREATE TABLE cdm_party_contact (
     party_id INT PRIMARY KEY,
     email VARCHAR(120) NOT NULL,
     phone CHAR(10) NOT NULL,
     preferred_channel VARCHAR(20) NOT NULL,
     KEY ix_contact_email (email),
     KEY ix_contact_phone (phone)
   )`,
  `CREATE TABLE cdm_digital_usage (
     party_id INT PRIMARY KEY,
     online_banking_since DATE NULL,
     mobile_since DATE NULL,
     mobile_deposit_since DATE NULL,
     estatements_since DATE NULL,
     bill_pay_since DATE NULL,
     direct_deposit_status VARCHAR(10) NOT NULL,
     direct_deposit_changed DATE NULL,
     last_login DATE NULL
   )`,
  // Scores on a 0-10 scale [Assumption CA-41], with the factors behind each one (FE-RM-002).
  `CREATE TABLE cdm_attrition_score (
     party_id INT PRIMARY KEY,
     score TINYINT NOT NULL,
     factors JSON NOT NULL,
     model_version VARCHAR(30) NOT NULL,
     run_date DATE NOT NULL
   )`,
  `CREATE TABLE cdm_suggestion (
     suggestion_id INT PRIMARY KEY,
     party_id INT NOT NULL,
     product VARCHAR(60) NOT NULL,
     referral_type_id VARCHAR(40) NULL,
     likelihood TINYINT NOT NULL,
     reason VARCHAR(200) NOT NULL,
     model_version VARCHAR(30) NOT NULL,
     run_date DATE NOT NULL,
     KEY ix_sugg_party (party_id)
   )`,
  `CREATE TABLE cdm_loan_application (
     application_id INT PRIMARY KEY,
     party_id INT NOT NULL,
     product VARCHAR(40) NOT NULL,
     amount DECIMAL(14,2) NOT NULL,
     status_group VARCHAR(12) NOT NULL,
     status_detail VARCHAR(80) NOT NULL,
     applied_date DATE NOT NULL,
     decided_date DATE NULL,
     status_code VARCHAR(24) NOT NULL,
     status_since DATE NOT NULL,
     owner_employee_id INT NOT NULL,
     branch_id INT NOT NULL,
     loan_category VARCHAR(40) NOT NULL,
     is_duplicate TINYINT NOT NULL,
     KEY ix_app_party (party_id),
     KEY ix_app_owner (owner_employee_id),
     KEY ix_app_branch (branch_id, status_code)
   )`,
  `CREATE TABLE cdm_interaction (
     interaction_id INT PRIMARY KEY,
     party_id INT NOT NULL,
     occurred_at DATETIME NOT NULL,
     channel VARCHAR(20) NOT NULL,
     kind VARCHAR(30) NOT NULL,
     summary VARCHAR(200) NOT NULL,
     employee_id INT NULL,
     KEY ix_int_party (party_id, occurred_at)
   )`,
  // "Recent change" compares today's balance with the balance 30 days earlier [CA-29].
  `CREATE TABLE cdm_account_activity (
     account_kind VARCHAR(8) NOT NULL,
     account_id INT NOT NULL,
     balance_30d DECIMAL(14,2) NOT NULL,
     fees_30d DECIMAL(10,2) NOT NULL,
     PRIMARY KEY (account_kind, account_id)
   )`,
];

export const RELATIONSHIP_TABLES = ['cdm_party_contact', 'cdm_digital_usage', 'cdm_attrition_score', 'cdm_suggestion', 'cdm_loan_application', 'cdm_interaction', 'cdm_account_activity'];

export const SCORE_MODELS = { attrition: 'attrition_v4', nextBest: 'next_best_product_v2', runDate: AS_OF };

export interface ScoreFactor {
  code: string;
  label: string;
  weight: number;
}

export interface RelationshipRows {
  contacts: unknown[][];
  digital: unknown[][];
  attrition: unknown[][];
  suggestions: unknown[][];
  applications: unknown[][];
  interactions: unknown[][];
  activity: unknown[][];
}

const DAY = 86_400_000;
const money = (n: number) => (n >= 1000 ? `$${(n / 1000).toFixed(1)}k` : `$${Math.round(n)}`);
const longDate = (iso: string) => new Date(`${iso}T00:00:00Z`).toLocaleDateString('en-US', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' });
const round2 = (n: number) => Math.round(n * 100) / 100;

export const LOAN_LABEL: Record<string, string> = { Auto: 'Auto loan', Personal: 'Personal loan', Business: 'Business loan', Consumer: 'Consumer loan', Mortgage: 'First mortgage' };

const INTERACTIONS: [channel: string, kind: string, summary: string][] = [
  ['Branch', 'Branch visit', 'Deposited a check at the counter'],
  ['Branch', 'Branch visit', 'Asked about certificate rates'],
  ['Phone', 'Phone call', 'Asked about a recent fee'],
  ['Phone', 'Phone call', 'Reported a lost debit card'],
  ['Online', 'Secure message', 'Updated mailing address'],
  ['Online', 'Secure message', 'Asked how to set up direct deposit'],
  ['Phone', 'Phone call', 'Loan payment question'],
  ['Branch', 'Branch visit', 'Opened a new account'],
  ['Online', 'Chat', 'Reset online banking password'],
  ['Phone', 'Phone call', 'Disputed a card transaction'],
];

const PENDING = ['In underwriting', 'Waiting for proof of income', 'Waiting for a pay stub', 'Waiting for title documents'];

/**
 * The demo member's own story, so the 360 shows the moments the spec's dialogs describe: a pending
 * auto loan application, savings only, no recent login and a medium attrition risk. Party 1 holds
 * Share Savings and a paid-off personal loan in the warehouse; nothing here changes those rows.
 */
const DEMO = {
  partyId: 1,
  digital: ['2024-03-01', '2024-03-01', null, null, null, 'none', null, '2026-09-08'] as const,
  savingsBefore: 6_590,
  application: ['Auto loan', 18_500, 'Pending', 'Waiting for a pay stub', '2026-10-18', null] as const,
  interactions: [
    ['2026-10-18 10:42:00', 'Branch', 'Branch visit', 'Applied for an auto loan', 1],
    ['2026-10-02 16:05:00', 'Phone', 'Phone call', 'Asked how to set up direct deposit', 3],
    ['2026-08-14 12:20:00', 'Online', 'Secure message', 'Requested a replacement debit card', null],
    ['2026-06-03 09:55:00', 'Branch', 'Branch visit', 'Deposited a check at the counter', 4],
  ] as const,
};

export function generateRelationship(t: GeneratedTenant): RelationshipRows {
  const r = prng(t.profile.seed ^ 0x5eed0360);
  const asOf = new Date(`${AS_OF}T00:00:00Z`);
  const daysAgo = (n: number) => ymd(new Date(asOf.getTime() - Math.round(n) * DAY));
  const between = (from: string, to = AS_OF) => {
    const a = new Date(`${from}T00:00:00Z`).getTime();
    const b = new Date(`${to}T00:00:00Z`).getTime();
    return ymd(new Date(a + r() * Math.max(0, b - a)));
  };

  const loansBy = new Map<number, unknown[][]>();
  for (const l of t.loans) (loansBy.get(l[1] as number) ?? loansBy.set(l[1] as number, []).get(l[1] as number)!).push(l);
  const depsBy = new Map<number, unknown[][]>();
  for (const d of t.deposits) (depsBy.get(d[1] as number) ?? depsBy.set(d[1] as number, []).get(d[1] as number)!).push(d);
  const staff = new Map<number, number[]>();
  for (const e of t.employees) if (e[2] !== 'Branch manager') (staff.get(e[3] as number) ?? staff.set(e[3] as number, []).get(e[3] as number)!).push(e[0] as number);

  const loanCats = new Set(t.profile.loans.map((l) => l.category));
  const savingsCat = t.profile.deposits[0]!.category;
  const certCat = t.profile.deposits.find((d) => d.maturing)?.category;
  const cardCat = loanCats.has('Credit Card') ? 'Credit Card' : null;

  const out: RelationshipRows = { contacts: [], digital: [], attrition: [], suggestions: [], applications: [], interactions: [], activity: [] };
  let suggestionId = 1;
  let applicationId = 1;
  let interactionId = 1;

  for (const p of t.parties) {
    const [id, first, last, birth, join, branch, segment, , isMember] = p as [number, string, string, string, string, number, string, number, number];
    const demo = id === DEMO.partyId;
    const age = (asOf.getTime() - new Date(`${birth}T00:00:00Z`).getTime()) / (365.25 * DAY);
    const tenureYears = (asOf.getTime() - new Date(`${join}T00:00:00Z`).getTime()) / (365.25 * DAY);
    const loans = (loansBy.get(id) ?? []).filter((l) => !l[7] && !l[8] && (l[10] as number) > 0);
    const deps = (depsBy.get(id) ?? []).filter((d) => !d[5]);
    const cats = new Set([...loans.map((l) => l[4] as string), ...deps.map((d) => d[3] as string)]);
    const hasChecking = cats.has('Checking');

    // Contact details are fictional: example.com addresses and 555 numbers.
    const phone = `555${String((id * 7919) % 10_000_000).padStart(7, '0')}`;
    const email = `${first}.${last}${id}@example.com`.toLowerCase().replace(/[^a-z0-9.@]/g, '');
    const preferred = age < 30 ? (r() < 0.6 ? 'Text' : 'Email') : age > 65 ? (r() < 0.6 ? 'Phone' : 'Mail') : r() < 0.5 ? 'Email' : 'Phone';
    out.contacts.push([id, email, phone, preferred]);

    // Digital use: younger members adopt more; direct deposit and bill pay need a checking account.
    const adopt = age < 30 ? 0.9 : age > 65 ? 0.45 : 0.75;
    let digital: (string | null)[];
    if (demo) {
      digital = [...DEMO.digital];
    } else {
      const olb = r() < adopt ? between(join) : null;
      const mobile = r() < adopt * 0.9 ? between(join) : null;
      const mdep = mobile && r() < 0.55 ? between(mobile) : null;
      const estmt = r() < adopt * 0.6 ? between(join) : null;
      const bill = hasChecking && r() < 0.35 ? between(join) : null;
      const ddRoll = r();
      const dd = !hasChecking ? 'none' : ddRoll < 0.62 ? 'active' : ddRoll < 0.72 ? 'stopped' : 'none';
      const ddChanged = dd === 'active' ? between(join) : dd === 'stopped' ? daysAgo(10 + r() * 110) : null;
      const login = olb || mobile ? daysAgo(r() < 0.88 ? r() * r() * 40 : 45 + r() * 160) : null;
      digital = [olb, mobile, mdep, estmt, bill, dd, ddChanged, login];
    }
    out.digital.push([id, ...digital]);
    const ddStatus = digital[5]!;
    const lastLogin = digital[7];

    // 30-day activity: balances drift a little; a stopped direct deposit drains checking.
    let depNow = 0;
    let dep30 = 0;
    let fees = 0;
    for (const d of deps) {
      const bal = d[7] as number;
      let before = bal * (1 + (r() - 0.5) * 0.08);
      if (ddStatus === 'stopped' && d[3] === 'Checking') before = bal * (1.35 + r() * 0.4);
      if (demo && d[3] === savingsCat) before = DEMO.savingsBefore;
      const fee = d[3] === 'Checking' ? (r() < 0.1 ? (r() < 0.5 ? 29 : 58) : r() < 0.2 ? 5 : 0) : 0;
      depNow += bal;
      dep30 += before;
      fees += fee;
      out.activity.push(['deposit', d[0], round2(before), fee]);
    }
    for (const l of loans) {
      const bal = l[10] as number;
      const fee = r() < 0.03 ? 25 : 0;
      fees += fee;
      out.activity.push(['loan', l[0], round2(bal * (1.008 + r() * 0.01)), fee]);
    }

    // Attrition: factors computed from the member's own data, then a little model noise.
    const factors: { code: string; label: string; weight: number }[] = [];
    if (ddStatus === 'stopped' && digital[6] && digital[6] >= daysAgo(120)) factors.push({ code: 'direct_deposit_stopped', label: `Direct deposit stopped on ${longDate(digital[6])}`, weight: 3 });
    const change = dep30 > 0 ? (depNow - dep30) / dep30 : 0;
    if (change < -0.15) factors.push({ code: 'balance_drop', label: `Deposit balances down ${Math.round(-change * 100)}% in 30 days`, weight: 2 });
    if (cats.size <= 1) factors.push({ code: 'single_product', label: 'Holds only one product', weight: 2 });
    if (tenureYears < 3) factors.push({ code: 'short_tenure', label: 'Relationship under 3 years', weight: 1 });
    if (lastLogin && lastLogin <= daysAgo(45)) factors.push({ code: 'no_recent_login', label: `No online or mobile login since ${longDate(lastLogin)}`, weight: 1 });
    if (fees >= 29) factors.push({ code: 'recent_fees', label: `${money(fees)} in fees in the last 30 days`, weight: 1 });
    const maturing = deps.find((d) => d[6] && (d[6] as string) >= AS_OF && (d[6] as string) <= ymd(new Date(asOf.getTime() + 30 * DAY)));
    if (maturing) factors.push({ code: 'certificate_maturing', label: `Certificate matures on ${longDate(maturing[6] as string)}`, weight: 1 });
    if (cats.size >= 4) factors.push({ code: 'many_products', label: `Holds ${cats.size} products`, weight: -1 });
    const noise = demo ? 0 : Math.floor(unit(id, 41) * 3) - 1;
    const score = Math.max(0, Math.min(10, factors.reduce((s, f) => s + f.weight, 0) + noise));
    factors.sort((a, b) => b.weight - a.weight);
    out.attrition.push([id, score, JSON.stringify(factors), SCORE_MODELS.attrition, SCORE_MODELS.runDate]);

    // Loan applications in the last 365 days (LAP status groups Approved, Denied, Pending).
    const apps: unknown[][] = [];
    if (demo) {
      apps.push([applicationId++, id, ...DEMO.application]);
    } else if (isMember && r() < 0.06) {
      const mix = t.profile.loans[Math.floor(r() * t.profile.loans.length)]!;
      const applied = daysAgo(r() * 360);
      const recent = applied >= daysAgo(21);
      const roll = r();
      const status = recent && roll < 0.7 ? 'Pending' : roll < (recent ? 0.78 : 0.25) ? 'Denied' : 'Approved';
      const detail = status === 'Pending' ? PENDING[Math.floor(r() * PENDING.length)]! : status === 'Approved' ? 'Funded' : 'Declined by underwriting';
      const amount = Math.round((mix.min + Math.pow(r(), 1.6) * (mix.max - mix.min)) / 100) * 100;
      apps.push([applicationId++, id, LOAN_LABEL[mix.category] ?? mix.category, amount, status, detail, applied, status === 'Pending' ? null : ymd(new Date(new Date(`${applied}T00:00:00Z`).getTime() + (2 + r() * 9) * DAY))]);
    }
    out.applications.push(...apps);
    const pendingProducts = new Set(apps.filter((a) => a[4] === 'Pending').map((a) => a[2] as string));

    // Next best product: rules on what the member holds, scored 0-10. Only 6 and above are shown.
    const suggest = (product: string, referralType: string | null, base: number, reason: string) => {
      if (pendingProducts.has(product)) return;
      const likelihood = Math.max(0, Math.min(10, Math.round(base + unit(id, product.length * 7 + base) * 2 - 0.5)));
      if (likelihood >= 3) out.suggestions.push([suggestionId++, id, product, referralType, likelihood, reason, SCORE_MODELS.nextBest, SCORE_MODELS.runDate]);
    };
    const savings = deps.filter((d) => d[3] === savingsCat || d[3] === 'Money Market').reduce((s, d) => s + (d[7] as number), 0);
    if (isMember) {
      if (!hasChecking) suggest('Checking', null, demo ? 8.5 : age < 30 ? 7.5 : 6, `No checking account; deposits are in ${[...cats].filter((c) => !loanCats.has(c)).join(' and ') || 'savings'} only`);
      if (cats.has('Mortgage') && loanCats.has('HELOC') && !cats.has('HELOC')) suggest('HELOC', 'heloc', 7, 'Has a first mortgage with us and no home equity line');
      if (cardCat && !cats.has(cardCat)) suggest('Credit card', 'credit_card', age < 30 ? 6.5 : 5, 'No credit card with us');
      if (certCat && maturing) suggest('Certificate', 'certificate', 8, `Certificate matures on ${longDate(maturing[6] as string)}; no renewal instruction on file`);
      else if (certCat && !cats.has(certCat) && savings >= 15_000) suggest('Certificate', 'certificate', 6.5, `${money(savings)} in savings and money market, and no certificate`);
      if (!cats.has('Auto') && age >= 22 && age <= 65) suggest('Auto loan', 'auto_loan', demo ? 6 : 4.5, 'No auto loan with us');
      if (segment === 'Small Business' && !cats.has('Business')) suggest('Business account', 'business_account', 7, 'Small business segment with no business account');
      if (!cats.has('Mortgage') && age >= 27 && age <= 45 && savings >= 20_000) suggest('First mortgage', 'mortgage', 5.5, `${money(savings)} in savings and no mortgage`);
    }

    // Interactions in the last 365 days, from COMs and the contact centre landing table [CA-29].
    if (demo) {
      for (const [at, channel, kind, summary, emp] of DEMO.interactions) out.interactions.push([interactionId++, id, at, channel, kind, summary, emp]);
    } else if (isMember) {
      const n = Math.floor(Math.pow(r(), 1.5) * 7);
      const branchStaff = staff.get(branch) ?? [];
      for (let k = 0; k < n; k++) {
        const [channel, kind, summary] = INTERACTIONS[Math.floor(r() * INTERACTIONS.length)]!;
        const day = daysAgo(r() * 364);
        const time = `${String(9 + Math.floor(r() * 8)).padStart(2, '0')}:${String(Math.floor(r() * 60)).padStart(2, '0')}:00`;
        const emp = channel === 'Online' || !branchStaff.length ? null : branchStaff[Math.floor(r() * branchStaff.length)]!;
        out.interactions.push([interactionId++, id, `${day} ${time}`, channel, kind, summary, emp]);
      }
    }
  }
  return out;
}

/** The workflow store's record of "Member declined" (spec 17.2): it suppresses the suggestion. */
export const DECLINE_DDL = `CREATE TABLE mod_suggestion_decline (
     decline_id INT AUTO_INCREMENT PRIMARY KEY,
     party_id INT NOT NULL,
     suggestion_id INT NOT NULL,
     product VARCHAR(60) NOT NULL,
     declined_by VARCHAR(40) NOT NULL,
     declined_by_name VARCHAR(80) NOT NULL,
     declined_at DATETIME(3) NOT NULL,
     suppressed_until DATE NOT NULL,
     approval_id VARCHAR(40) NOT NULL,
     reversed_at DATETIME(3) NULL,
     UNIQUE KEY ux_decline_approval (approval_id),
     KEY ix_decline_party (party_id)
   )`;
