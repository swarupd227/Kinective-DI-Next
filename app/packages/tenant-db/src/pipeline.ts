// Loan Application Pipeline data (spec 17.5): the status map, stall thresholds, status history and
// the monthly rollup behind the approval rate. The member's applications keep their figures: this
// adds the LOS fields to them, then adds work in progress across every branch from its own seed.
import { AS_OF, prng, unit, ymd, type GeneratedTenant } from './generate.ts';
import { LOAN_LABEL } from './relationship.ts';

export const PIPELINE_DDL = [
  // One row per raw LOS status (BE-LAP-001). Names, groups and visibility are the tenant's, not code.
  `CREATE TABLE mod_lap_status_map (
     status_code VARCHAR(24) PRIMARY KEY,
     label VARCHAR(60) NOT NULL,
     definition VARCHAR(200) NOT NULL,
     in_progress TINYINT NOT NULL,
     visible TINYINT NOT NULL,
     reporting_group VARCHAR(40) NOT NULL,
     sort_order INT NOT NULL,
     stall_days INT NULL
   )`,
  // A product's own threshold, where it differs from the status default (AI-AGT-180).
  `CREATE TABLE mod_lap_stall_threshold (
     status_code VARCHAR(24) NOT NULL,
     product VARCHAR(40) NOT NULL,
     days INT NOT NULL,
     updated_by VARCHAR(40) NOT NULL,
     updated_at DATETIME NOT NULL,
     PRIMARY KEY (status_code, product)
   )`,
  `CREATE TABLE cdm_loan_app_status_history (
     application_id INT NOT NULL,
     status_code VARCHAR(24) NOT NULL,
     entered_date DATE NOT NULL,
     KEY ix_lap_hist (application_id, entered_date)
   )`,
  `CREATE TABLE hist_lap_month (
     month_end DATE NOT NULL,
     branch_id INT NOT NULL,
     loan_category VARCHAR(40) NOT NULL,
     application_count INT NOT NULL,
     approved_count INT NOT NULL,
     decided_count INT NOT NULL,
     PRIMARY KEY (month_end, branch_id, loan_category)
   )`,
  // What an application is waiting on, as the LOS records it. Names and next steps are the tenant's.
  `CREATE TABLE mod_lap_hold_reason (
     hold_code VARCHAR(24) PRIMARY KEY,
     label VARCHAR(80) NOT NULL,
     waiting_on VARCHAR(40) NOT NULL,
     next_step VARCHAR(120) NOT NULL
   )`,
  `CREATE TABLE cdm_loan_app_hold (
     application_id INT PRIMARY KEY,
     hold_code VARCHAR(24) NOT NULL,
     since_date DATE NOT NULL
   )`,
  // The LOS feed loads on its own; a build can finish without it (spec 24.18 failure behaviour).
  `CREATE TABLE meta_lap_load (
     load_date DATE PRIMARY KEY,
     state VARCHAR(12) NOT NULL
   )`,
];

export const PIPELINE_WRITE_TABLES = ['mod_lap_stall_threshold'];

/** Stock statuses [REQ LAP], and the booklet's stages as reporting groups [BK p25]. */
export const LAP_STATUSES = [
  ['RECEIVED', 'Application received', 'Taken in the LOS and not yet reviewed.', 1, 1, 'Pending', 1, 2],
  ['DOCUMENTS', 'Waiting on documents', 'The lender is waiting for something from the applicant.', 1, 1, 'Pending', 2, 7],
  ['UNDERWRITING', 'In underwriting', 'With an underwriter for a decision.', 1, 1, 'Pending', 3, 5],
  ['COUNTER', 'Counter offer', 'An offer on different terms is with the applicant.', 1, 1, 'Counter Offer', 4, 5],
  ['DENIED_DM', 'Denied by DM', 'Declined by a decision manager.', 0, 1, 'Denied by DM', 5, null],
  ['AUTO_APPROVED', 'Auto approved', 'Approved by the LOS decision rules.', 0, 1, 'Auto Approved', 6, null],
  ['APPROVED', 'Approved', 'Approved by a lender.', 0, 1, 'Approved', 7, null],
  ['WITHDRAWN', 'Withdrawn', 'Withdrawn by the applicant. Hidden from pipeline views.', 0, 0, 'Withdrawn', 8, null],
] as const;

/** Demo hold reasons [Assumption]: confirm the real LOS records these before relying on them. */
export const LAP_HOLDS = [
  ['INTAKE', 'It hasn’t been picked up for review', 'the lending queue', 'Get it assigned for review.', 'RECEIVED', null],
  ['INCOMPLETE_APP', 'The application is missing required details', 'the applicant', 'Get the missing details from the applicant.', 'RECEIVED', null],
  ['INCOME_DOCS', 'Proof of income hasn’t come in', 'the applicant', 'Follow up with the applicant for proof of income.', 'DOCUMENTS', null],
  ['ID_DOCS', 'ID verification is outstanding', 'the applicant', 'Follow up with the applicant to finish ID verification.', 'DOCUMENTS', null],
  ['INSURANCE', 'Proof of insurance hasn’t come in', 'the applicant', 'Follow up with the applicant for proof of insurance.', 'DOCUMENTS', /auto|mortgage|heloc/i],
  ['FINANCIALS', 'Business financial statements are incomplete', 'the applicant', 'Follow up with the applicant for the missing statements.', 'DOCUMENTS', /business|commercial/i],
  ['APPRAISAL', 'The appraisal isn’t back', 'the appraiser', 'Check when the appraisal is due.', 'UNDERWRITING', /mortgage|heloc/i],
  ['TITLE', 'Title work is still open', 'the title company', 'Check on the title work.', 'UNDERWRITING', /mortgage|heloc/i],
  ['UW_QUEUE', 'It’s in the underwriter’s queue, not yet reviewed', 'the underwriter', 'Ask underwriting where it sits in the queue.', 'UNDERWRITING', null],
  ['DTI', 'Debt-to-income needs a second review', 'the underwriter', 'Go through income and debts with the underwriter.', 'UNDERWRITING', null],
  ['COUNTER_REPLY', 'The applicant hasn’t answered the counter offer', 'the applicant', 'Follow up with the applicant on the offer.', 'COUNTER', null],
] as const;

export const LAP_APPLICATION_COLUMNS = ['application_id', 'party_id', 'product', 'amount', 'status_group', 'status_detail', 'applied_date', 'decided_date', 'status_code', 'status_since', 'owner_employee_id', 'branch_id', 'loan_category', 'is_duplicate'];

const OPEN_PER_BRANCH = 24;
const DECIDED_PER_BRANCH = 30;
const DUPLICATE_DAYS = 7;
const DAY = 86_400_000;

interface App {
  id: number;
  party: number;
  product: string;
  amount: number;
  group: string;
  detail: string;
  applied: string;
  decided: string | null;
  code: string;
  since: string;
  owner: number;
  branch: number;
  category: string;
  duplicate: boolean;
}

/** The stock rule [CA-35]: same applicant, same category, within 7 days of the earliest. */
export function markDuplicates<T extends { id: number; party: number; category: string; applied: string; duplicate: boolean }>(apps: T[]) {
  const earliest = new Map<string, string>();
  for (const a of [...apps].sort((x, y) => x.applied.localeCompare(y.applied) || x.id - y.id)) {
    const key = `${a.party}|${a.category}`;
    const first = earliest.get(key);
    a.duplicate = first !== undefined && (Date.parse(a.applied) - Date.parse(first)) / DAY <= DUPLICATE_DAYS;
    if (!a.duplicate) earliest.set(key, a.applied);
  }
  return apps;
}

export function generatePipeline(t: GeneratedTenant, applications: unknown[][]) {
  const r = prng(t.profile.seed ^ 0x1a9c5);
  const asOf = Date.parse(`${AS_OF}T00:00:00Z`);
  const daysAgo = (n: number) => ymd(new Date(asOf - Math.floor(n) * DAY));
  const parties = new Map((t.parties as unknown[][]).map((p) => [p[0] as number, p]));
  const officers = (branch: number) => (t.employees as unknown[][]).filter((e) => e[3] === branch && e[2] === 'Loan officer').map((e) => e[0] as number);
  const ownerFor = (party: number, branch: number) => {
    const staff = officers(branch);
    return staff[Math.floor(unit(party, 77) * staff.length)]!;
  };
  const categoryOf = new Map(t.profile.loans.map((l) => [LOAN_LABEL[l.category] ?? l.category, l.category]));
  const after = (date: string, days: number) => ymd(new Date(Date.parse(`${date}T00:00:00Z`) + days * DAY));

  const apps: App[] = (applications as [number, number, string, number, string, string, string, string | null][]).map(([id, party, product, amount, group, detail, applied, decided]) => {
    const branch = parties.get(party)![5] as number;
    const code = group === 'Pending' ? (detail === 'In underwriting' ? 'UNDERWRITING' : 'DOCUMENTS') : group === 'Denied' ? 'DENIED_DM' : r() < 0.3 ? 'AUTO_APPROVED' : 'APPROVED';
    const age = Math.round((asOf - Date.parse(`${applied}T00:00:00Z`)) / DAY);
    return { id, party, product, amount, group, detail, applied, decided, code, since: decided ?? (party === 1 ? applied : after(applied, Math.floor(r() * (age + 1)))), owner: ownerFor(party, branch), branch, category: categoryOf.get(product) ?? product, duplicate: false };
  });

  // Each new application goes to someone without one, so a member's record stays believable.
  const taken = new Set(apps.map((a) => a.party));
  const members = (t.parties as unknown[][]).filter((p) => p[8] === 1 && !taken.has(p[0] as number));
  let nextId = Math.max(0, ...apps.map((a) => a.id)) + 1;
  const pick = (branch: number) => {
    const pool = members.filter((p) => p[5] === branch);
    const p = pool[Math.floor(r() * pool.length)]!;
    members.splice(members.indexOf(p), 1);
    return p[0] as number;
  };
  const loan = () => {
    const mix = t.profile.loans[Math.floor(r() * t.profile.loans.length)]!;
    return { product: LOAN_LABEL[mix.category] ?? mix.category, category: mix.category, amount: Math.round((mix.min + Math.pow(r(), 1.6) * (mix.max - mix.min)) / 100) * 100 };
  };
  const label = (code: string) => LAP_STATUSES.find((s) => s[0] === code)![1];

  t.locations.forEach((_, i) => {
    const branch = i + 1;
    for (let n = 0; n < OPEN_PER_BRANCH; n++) {
      const party = pick(branch);
      const roll = r();
      const code = roll < 0.15 ? 'RECEIVED' : roll < 0.45 ? 'DOCUMENTS' : roll < 0.85 ? 'UNDERWRITING' : 'COUNTER';
      const waited = Math.floor(Math.pow(r(), 3) * 20);
      apps.push({ id: nextId++, party, ...loan(), group: 'Pending', detail: label(code), applied: daysAgo(waited + 1 + r() * 8), decided: null, code, since: daysAgo(waited), owner: ownerFor(party, branch), branch, duplicate: false });
    }
    for (let n = 0; n < DECIDED_PER_BRANCH; n++) {
      const party = pick(branch);
      const decided = daysAgo(r() * 120);
      const roll = r();
      const code = roll < 0.22 ? 'DENIED_DM' : roll < 0.3 ? 'WITHDRAWN' : roll < 0.55 ? 'AUTO_APPROVED' : 'APPROVED';
      const group = code === 'DENIED_DM' || code === 'WITHDRAWN' ? 'Denied' : 'Approved';
      apps.push({ id: nextId++, party, ...loan(), group, detail: code === 'DENIED_DM' ? 'Declined by underwriting' : code === 'WITHDRAWN' ? 'Withdrawn by the applicant' : 'Funded', applied: after(decided, -(2 + Math.floor(r() * 9))), decided, code, since: decided, owner: ownerFor(party, branch), branch, duplicate: false });
    }
  });
  // One application keyed twice, as LOS data has, so the duplicate rule has something to catch.
  const twin = apps.find((a) => a.branch === 1 && a.code === 'UNDERWRITING' && a.party !== 1)!;
  apps.push({ ...twin, id: nextId++, applied: after(twin.applied, 2) });
  markDuplicates(apps);

  const history: unknown[][] = [];
  for (const a of apps) {
    history.push([a.id, 'RECEIVED', a.applied]);
    if (a.code === 'COUNTER') history.push([a.id, 'UNDERWRITING', a.since > a.applied ? after(a.applied, 1) : a.applied]);
    if (a.code !== 'RECEIVED') history.push([a.id, a.code, a.since]);
  }

  // Keyed on the application, not the generator, so adding these moved no existing figure. Some have
  // no reason recorded, as real LOS data doesn't.
  const holds: unknown[][] = [];
  for (const a of apps) {
    const options = LAP_HOLDS.filter((h) => h[4] === a.code && (!h[5] || h[5].test(a.product)));
    if (!options.length || a.duplicate || unit(a.id, 91) < 0.1) continue;
    const waited = Math.round((asOf - Date.parse(`${a.since}T00:00:00Z`)) / DAY);
    holds.push([a.id, options[Math.floor(unit(a.id, 92) * options.length)]![0], after(a.since, Math.min(waited, Math.floor(unit(a.id, 93) * 3)))]);
  }

  // Complete months only, like the rest of the history tables.
  const lastMonth = ymd(new Date(Date.UTC(new Date(asOf).getUTCFullYear(), new Date(asOf).getUTCMonth(), 0)));
  const monthEnd = (date: string) => {
    const d = new Date(`${date}T00:00:00Z`);
    return ymd(new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0)));
  };
  const months = new Map<string, unknown[]>();
  const row = (date: string, a: App) => {
    const me = monthEnd(date);
    if (me > lastMonth) return null;
    const key = `${me}|${a.branch}|${a.category}`;
    if (!months.has(key)) months.set(key, [me, a.branch, a.category, 0, 0, 0]);
    return months.get(key)!;
  };
  for (const a of apps.filter((x) => !x.duplicate)) {
    const opened = row(a.applied, a);
    if (opened) opened[3] = (opened[3] as number) + 1;
    if (!a.decided || a.code === 'WITHDRAWN') continue;
    const decided = row(a.decided, a);
    if (!decided) continue;
    decided[5] = (decided[5] as number) + 1;
    if (a.code !== 'DENIED_DM') decided[4] = (decided[4] as number) + 1;
  }

  return {
    applications: apps.map((a) => [a.id, a.party, a.product, a.amount, a.group, a.detail, a.applied, a.decided, a.code, a.since, a.owner, a.branch, a.category, a.duplicate ? 1 : 0]),
    history,
    holds,
    months: [...months.values()],
  };
}
