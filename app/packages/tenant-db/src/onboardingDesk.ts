// The rest of DI's Onboarding Manager: each touch point's type and priority, whether the person is
// subscribed to the onboarding messages, the follow-up rules staff set up (in groups, reusable), and
// the Employment, Leisure and Life Events tabs, kept for every member who shared them.
// Demo data [Assumption: demo]; drawn with unit() so nothing else moves.
import { AS_OF, unit } from './generate.ts';

export const ONB_DESK_DDL = [
  `ALTER TABLE onb_task ADD COLUMN touch_type VARCHAR(16) NOT NULL DEFAULT 'Call', ADD COLUMN priority VARCHAR(8) NOT NULL DEFAULT 'Normal', ADD COLUMN rule_id INT NULL`,
  `CREATE TABLE onb_subscription (party_id INT PRIMARY KEY, subscribed TINYINT NOT NULL, changed DATE NOT NULL)`,
  `CREATE TABLE onb_rule (rule_id INT AUTO_INCREMENT PRIMARY KEY, name VARCHAR(80) NOT NULL, group_name VARCHAR(60) NOT NULL, condition_code VARCHAR(30) NOT NULL, after_day INT NOT NULL, touch VARCHAR(60) NOT NULL, touch_type VARCHAR(16) NOT NULL, priority VARCHAR(8) NOT NULL, active TINYINT NOT NULL, created_by VARCHAR(80) NOT NULL, created_on DATE NOT NULL, copied_from INT NULL, approval_id VARCHAR(40) NULL, UNIQUE KEY ux_onb_rule_approval (approval_id))`,
  `CREATE TABLE cdm_party_profile (party_id INT PRIMARY KEY, employer VARCHAR(80) NULL, occupation VARCHAR(60) NULL, income_band VARCHAR(20) NULL, years_employed INT NULL, interests JSON NOT NULL, life_events JSON NOT NULL, goals JSON NOT NULL)`,
];
export const ONB_DESK_WRITE_TABLES = ['onb_rule', 'onb_subscription'];
/** After the touch points load: what kind of contact each is, and which come first. */
export const ONB_DESK_UPDATES = [
  "UPDATE onb_task SET touch_type = CASE touch WHEN 'Welcome call' THEN 'Call' WHEN 'Digital set-up check' THEN 'Secure message' WHEN '30-day check-in' THEN 'Call' WHEN '60-day review' THEN 'Email' WHEN '90-day review' THEN 'Visit' ELSE 'Call' END",
  "UPDATE onb_task SET priority = CASE WHEN touch IN ('Welcome call', '30-day check-in') THEN 'High' ELSE 'Normal' END",
];

/** What a follow-up rule watches for, and how DI says it. */
export const ONB_CONDITIONS: Record<string, string> = {
  no_direct_deposit: 'no direct deposit',
  no_digital: 'not enrolled in online or mobile banking',
  card_not_activated: 'debit card not activated',
  single_product: 'only one product',
  no_estatements: 'not on e-statements',
};

const EMPLOYERS = ['Riverside Health', 'Harbor Logistics', 'Lakeshore Schools', 'Northgate Manufacturing', 'City of Westport', 'Brightline Software', 'Summit Dental Partners', 'Self-employed', 'Retired', 'Iron Horse Brewing', 'Tri-County Electric Co-op', 'Clearwater Labs'];
const OCCUPATIONS = ['Nurse', 'Teacher', 'Truck driver', 'Software engineer', 'Electrician', 'Office manager', 'Sales associate', 'Machinist', 'Accountant', 'Dental hygienist', 'Small business owner', 'Police officer'];
const INCOME = ['Under $35K', '$35K–$60K', '$60K–$100K', '$100K–$150K', 'Over $150K'];
const INTERESTS = ['Travel', 'Fishing', 'Camping', 'Gardening', 'Home improvement', 'Youth sports', 'Boating', 'Cooking', 'Golf', 'Hiking', 'Classic cars', 'Volunteering'];
const EVENTS = ['New job', 'Marriage', 'New baby', 'Moved', 'Bought a home', 'Child started college', 'Retired', 'Started a business'];
const GOALS = ['Buy a home', 'Pay down debt', 'Save for college', 'Plan for retirement', 'Build an emergency fund', 'Buy a car', 'Remodel the kitchen', 'Start a business'];

const ymd = (d: number) => new Date(d).toISOString().slice(0, 10);
const DAY = 86_400_000;
const pickSome = (list: string[], seed: number, salt: number, n: number) => {
  const out: string[] = [];
  for (let i = 0; out.length < n && i < n * 4; i++) {
    const x = list[Math.floor(unit(seed + i, salt) * list.length)]!;
    if (!out.includes(x)) out.push(x);
  }
  return out;
};

/** parties: cdm_party rows; tasks: onb_task rows. */
export function generateOnboardingDesk(parties: unknown[][], tasks: unknown[][]) {
  const asOf = Date.parse(`${AS_OF}T00:00:00Z`);
  const onboarding = [...new Set(tasks.map((t) => t[1] as number))];
  const subscriptions = onboarding.map((id) => [id, unit(id, 1901) < 0.86 ? 1 : 0, ymd(asOf - Math.floor(5 + unit(id, 1902) * 80) * DAY)]);
  const rules = [
    ['Direct deposit by day 30', 'Standard', 'no_direct_deposit', 30, 'Direct deposit follow-up', 'Call', 'High', 1, 'Dana Lee', '2026-06-01', null, null],
    ['Digital banking by day 14', 'Standard', 'no_digital', 14, 'Help with online banking', 'Secure message', 'Normal', 1, 'Dana Lee', '2026-06-01', null, null],
    ['Debit card by day 10', 'Standard', 'card_not_activated', 10, 'Debit card activation reminder', 'Call', 'Normal', 1, 'Dana Lee', '2026-06-01', null, null],
    ['Second product by day 60', 'Growth', 'single_product', 60, 'Second product conversation', 'Call', 'Normal', 0, 'Dana Lee', '2026-07-15', null, null],
  ];
  const profiles: unknown[][] = [];
  for (const p of parties) {
    const id = p[0] as number;
    if (unit(id, 1910) >= 0.35) continue;
    const age = p[3] ? (asOf - Date.parse(`${String(p[3]).slice(0, 10)}T00:00:00Z`)) / (365.25 * DAY) : 40;
    const retired = age >= 66 && unit(id, 1911) < 0.8;
    const employer = retired ? 'Retired' : EMPLOYERS[Math.floor(unit(id, 1912) * (EMPLOYERS.length - 1))]!;
    const events = pickSome(EVENTS, id, 1913, unit(id, 1914) < 0.5 ? 1 : 2).map((e, i) => ({ event: e, date: ymd(asOf - Math.floor(unit(id + i, 1915) * 700) * DAY) }));
    profiles.push([
      id,
      employer,
      retired ? null : OCCUPATIONS[Math.floor(unit(id, 1916) * OCCUPATIONS.length)]!,
      INCOME[Math.floor(unit(id, 1917) * INCOME.length)]!,
      retired ? null : 1 + Math.floor(unit(id, 1918) * 20),
      JSON.stringify(pickSome(INTERESTS, id, 1919, 2 + Math.floor(unit(id, 1920) * 2))),
      JSON.stringify(events),
      JSON.stringify(pickSome(GOALS, id, 1921, 1 + Math.floor(unit(id, 1922) * 2))),
    ]);
  }
  return { subscriptions, rules, profiles };
}
