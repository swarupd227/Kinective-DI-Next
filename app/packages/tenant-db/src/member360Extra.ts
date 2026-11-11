// The rest of DI's Member 360: 90-day digital activity and fees, survey scores, the core's account
// comments and warning codes, the rewards program, and a log of identity verifications done in DI.
// Demo data [Assumption: demo]; drawn with unit() so nothing else in the seed moves.
import { AS_OF, unit } from './generate.ts';

export const MEMBER360_EXTRA_DDL = [
  `CREATE TABLE cdm_party_activity (party_id INT PRIMARY KEY, logins_90d INT NOT NULL, mobile_logins_90d INT NOT NULL, bill_payments_90d INT NOT NULL, mobile_deposits_90d INT NOT NULL, fees_90d DECIMAL(10,2) NOT NULL)`,
  `CREATE TABLE cdm_survey (survey_id INT AUTO_INCREMENT PRIMARY KEY, party_id INT NOT NULL, survey_date DATE NOT NULL, kind VARCHAR(30) NOT NULL, score TINYINT NOT NULL, comment VARCHAR(200) NULL, KEY ix_survey_party (party_id))`,
  `CREATE TABLE cdm_account_comment (comment_id INT AUTO_INCREMENT PRIMARY KEY, party_id INT NOT NULL, account_id INT NULL, kind VARCHAR(10) NOT NULL, code VARCHAR(10) NULL, text VARCHAR(200) NOT NULL, created DATE NOT NULL, created_by VARCHAR(80) NOT NULL, active TINYINT NOT NULL, KEY ix_comment_party (party_id))`,
  `CREATE TABLE rwd_member (party_id INT PRIMARY KEY, tier VARCHAR(20) NOT NULL, points INT NOT NULL, enrolled_on DATE NOT NULL)`,
  `CREATE TABLE rwd_ledger (entry_id INT AUTO_INCREMENT PRIMARY KEY, party_id INT NOT NULL, posted DATE NOT NULL, description VARCHAR(80) NOT NULL, points INT NOT NULL, KEY ix_rwd_party (party_id))`,
  `CREATE TABLE rm_verification (verification_id INT AUTO_INCREMENT PRIMARY KEY, party_id INT NOT NULL, verified_at DATETIME NOT NULL, channel VARCHAR(20) NOT NULL, result VARCHAR(10) NOT NULL, checks VARCHAR(300) NOT NULL, by_name VARCHAR(80) NOT NULL, approval_id VARCHAR(40) NULL, KEY ix_verify_party (party_id))`,
];
export const MEMBER360_EXTRA_WRITE_TABLES = ['rm_verification'];

/** The core's warning codes: what each means for whoever opens the record. */
export const WARNING_CODES: [string, string][] = [
  ['W01', 'Returned mail: confirm the address before mailing'],
  ['W03', 'Legal hold on the account: no withdrawals without Operations'],
  ['W04', 'Overdraft privilege suspended'],
  ['W05', 'Do not mail: statements and notices go electronically'],
  ['W07', 'Fraud alert: verify identity in person before any change'],
  ['W09', 'Bankruptcy filed: no collection contact, refer to Collections'],
];
const COMMENTS = [
  'Prefers a call after 5 pm.',
  'Power of attorney on file; agent is the member’s daughter.',
  'Asked for paper statement copies for a mortgage application.',
  'Spanish preferred at branch visits.',
  'Disputed an ATM withdrawal; resolved in the member’s favor.',
  'Travel notice on file for the debit card.',
  'Wants to be told before a certificate renews.',
  'Joint owner added; signature card updated.',
];
const SURVEY_KINDS = ['Relationship survey', 'Branch visit', 'Loan closing', 'Digital banking'];
const SURVEY_COMMENTS = ['Staff were friendly and quick.', 'Waited too long at the branch.', 'The app makes this easy.', 'Rates could be better.', 'Loan closing was smooth.', 'Had to call twice to fix a fee.', null, null, null];
const EARN = ['Debit card purchases', 'Direct deposit bonus', 'Bill pay bonus', 'Referral bonus', 'Credit card purchases'];

const ymd = (d: number) => new Date(d).toISOString().slice(0, 10);
const DAY = 86_400_000;

/**
 * parties: cdm_party rows; digital: cdm_digital_usage rows; deposits: cdm_deposit_account rows;
 * activity: cdm_account_activity rows (kind, id, balance 30 days ago, fees in 30 days); loans: cdm_loan rows.
 */
export function generateMember360Extra(parties: unknown[][], digital: unknown[][], deposits: unknown[][], loans: unknown[][], activity: unknown[][]) {
  const asOf = Date.parse(`${AS_OF}T00:00:00Z`);
  const ownerOf = new Map<string, number>();
  for (const d of deposits) ownerOf.set(`deposit:${d[0]}`, d[1] as number);
  for (const l of loans) ownerOf.set(`loan:${l[0]}`, l[1] as number);
  const fees30 = new Map<number, number>();
  for (const a of activity) {
    const p = ownerOf.get(`${a[0]}:${a[1]}`);
    if (p !== undefined) fees30.set(p, (fees30.get(p) ?? 0) + Number(a[3] ?? 0));
  }
  const firstDeposit = new Map<number, number>();
  for (const d of deposits) if (d[5] === null && !firstDeposit.has(d[1] as number)) firstDeposit.set(d[1] as number, d[0] as number);

  const partyActivity: unknown[][] = [];
  for (const d of digital) {
    const id = d[0] as number;
    const lastLogin = d[8] as string | null;
    const recent = lastLogin ? (asOf - Date.parse(`${lastLogin}T00:00:00Z`)) / DAY : 999;
    const active = recent <= 90;
    const logins = active ? Math.max(1, Math.round((1 - recent / 90) * (6 + unit(id, 1801) * 60))) : 0;
    const mobile = d[2] ? Math.round(logins * (0.5 + unit(id, 1802) * 0.45)) : 0;
    const billPays = d[5] && active ? Math.floor(unit(id, 1803) * 9) : 0;
    const mobileDeposits = d[3] && active ? Math.floor(unit(id, 1804) * 6) : 0;
    const fees = Math.round((fees30.get(id) ?? 0) * (2.2 + unit(id, 1805) * 1.4) * 100) / 100;
    partyActivity.push([id, logins, mobile, billPays, mobileDeposits, fees]);
  }

  const surveys: unknown[][] = [];
  const comments: unknown[][] = [];
  const rewards: unknown[][] = [];
  const ledger: unknown[][] = [];
  for (const p of parties) {
    const id = p[0] as number;
    if (unit(id, 1810) < 0.22) {
      const n = unit(id, 1811) < 0.3 ? 2 : 1;
      for (let i = 0; i < n; i++) {
        const r = unit(id * 3 + i, 1812);
        // Most people are satisfied; a tail aren't.
        const score = r < 0.12 ? Math.floor(r * 50) : r < 0.3 ? 7 + Math.floor(unit(id + i, 1813) * 2) : 9 + Math.floor(unit(id + i, 1814) * 2);
        const comment = SURVEY_COMMENTS[Math.floor(unit(id + i, 1815) * SURVEY_COMMENTS.length)] ?? null;
        surveys.push([id, ymd(asOf - Math.floor(unit(id + i, 1816) * 360) * DAY), SURVEY_KINDS[Math.floor(unit(id + i, 1817) * SURVEY_KINDS.length)], Math.min(10, score), score <= 6 && comment === null ? 'Not happy with how a fee was handled.' : comment]);
      }
    }
    const account = firstDeposit.get(id) ?? null;
    if (unit(id, 1820) < 0.06) {
      comments.push([id, account, 'Comment', null, COMMENTS[Math.floor(unit(id, 1821) * COMMENTS.length)], ymd(asOf - Math.floor(unit(id, 1822) * 700) * DAY), 'Member Services', 1]);
    }
    if (unit(id, 1823) < 0.02) {
      const [code, text] = WARNING_CODES[Math.floor(unit(id, 1824) * WARNING_CODES.length)]!;
      comments.push([id, account, 'Warning', code, text, ymd(asOf - Math.floor(unit(id, 1825) * 400) * DAY), 'Operations', 1]);
    }
    if (account !== null && unit(id, 1830) < 0.3) {
      let points = 0;
      const enrolled = asOf - Math.floor(60 + unit(id, 1831) * 900) * DAY;
      for (let m = 5; m >= 0; m--) {
        const posted = ymd(asOf - (m * 30 + Math.floor(unit(id + m, 1832) * 20)) * DAY);
        if (posted < ymd(enrolled)) continue;
        const earn = Math.round(50 + unit(id + m, 1833) * 650);
        points += earn;
        ledger.push([id, posted, EARN[Math.floor(unit(id + m, 1834) * EARN.length)], earn]);
        if (m === 2 && unit(id, 1835) < 0.35 && points > 500) {
          ledger.push([id, posted, 'Redeemed: statement credit', -500]);
          points -= 500;
        }
      }
      const total = points + Math.round(unit(id, 1836) * 4000);
      rewards.push([id, total >= 4000 ? 'Gold' : total >= 1500 ? 'Silver' : 'Bronze', total, ymd(enrolled)]);
    }
  }
  return { partyActivity, surveys, comments, rewards, ledger };
}
