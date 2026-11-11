// The onboarding journey around the touch points (DI's Onboarding Manager): the messages the scheduled
// process sent each new member, whether they were opened, and the checklist recorded when a touch point
// was worked. DI shows them; the scheduled process, not DI, sends the messages. Demo data [Assumption:
// demo], drawn with unit() so nothing else moves.
import { AS_OF, unit, type GeneratedTenant } from './generate.ts';

export const ONB_JOURNEY_DDL = [
  `CREATE TABLE onb_message (message_id INT AUTO_INCREMENT PRIMARY KEY, party_id INT NOT NULL, step VARCHAR(60) NOT NULL, channel VARCHAR(20) NOT NULL, day_offset INT NOT NULL, sent_on DATE NOT NULL, opened TINYINT NULL, clicked TINYINT NULL, KEY ix_onb_msg (party_id))`,
  `CREATE TABLE onb_checklist (task_id INT PRIMARY KEY, debit_card_activated TINYINT NOT NULL, online_banking TINYINT NOT NULL, mobile_app TINYINT NOT NULL, estatements TINYINT NOT NULL, bill_pay TINYINT NOT NULL, direct_deposit TINYINT NOT NULL, perks_reviewed TINYINT NOT NULL, loans_discussed VARCHAR(120) NULL, referral_made TINYINT NOT NULL, recorded_by VARCHAR(80) NOT NULL, recorded_on DATE NOT NULL)`,
];
export const ONB_JOURNEY_WRITE_TABLES = ['onb_checklist'];

/** The scheduled journey: what goes to every new member, on which day and how. */
export const ONB_JOURNEY = [
  { step: 'Welcome email', channel: 'Email', day: 0 },
  { step: 'Welcome kit letter', channel: 'Letter', day: 3 },
  { step: 'Digital banking tips', channel: 'Secure message', day: 14 },
  { step: 'Direct deposit reminder', channel: 'Email', day: 30, onlyWithoutDirectDeposit: true },
  { step: 'Products for you', channel: 'Email', day: 60 },
  { step: 'How are we doing? survey', channel: 'Email', day: 90 },
] as const;

const DAY = 86_400_000;
const LOANS = ['auto loan', 'personal line of credit', 'credit card', 'HELOC', 'signature loan'];

export function generateOnboardingJourney(t: GeneratedTenant, tasks: unknown[][], digital: unknown[][]) {
  const asOf = Date.parse(`${AS_OF}T00:00:00Z`);
  const joined = new Map((t.parties as unknown[][]).map((p) => [p[0] as number, String(p[4])]));
  const dd = new Map(digital.map((d) => [d[0] as number, d[6] === 'active']));
  const parties = [...new Set(tasks.map((k) => k[1] as number))];
  const messages: unknown[][] = [];
  for (const party of parties) {
    const join = joined.get(party);
    if (!join) continue;
    for (const [i, s] of ONB_JOURNEY.entries()) {
      if ('onlyWithoutDirectDeposit' in s && dd.get(party)) continue;
      const sent = Date.parse(`${join}T00:00:00Z`) + s.day * DAY;
      if (sent > asOf) continue;
      const u = unit(party * 10 + i, 1701);
      const opened = s.channel === 'Letter' ? null : u < (s.channel === 'Secure message' ? 0.72 : 0.52) ? 1 : 0;
      messages.push([party, s.step, s.channel, s.day, new Date(sent).toISOString().slice(0, 10), opened, opened ? (unit(party * 10 + i, 1702) < 0.35 ? 1 : 0) : opened === null ? null : 0]);
    }
  }
  // The checklist recorded with each touch point already worked.
  const checklists = tasks
    .filter((k) => k[5] === 'Done')
    .map((k) => {
      const id = k[0] as number;
      const yes = (salt: number, p: number) => (unit(id, salt) < p ? 1 : 0);
      const loans = unit(id, 1710) < 0.4 ? LOANS[Math.floor(unit(id, 1711) * LOANS.length)]! : null;
      return [id, yes(1703, 0.85), yes(1704, 0.8), yes(1705, 0.72), yes(1706, 0.55), yes(1707, 0.3), dd.get(k[1] as number) ? 1 : 0, yes(1708, 0.6), loans, yes(1709, 0.22), 'Branch staff', k[8] ?? AS_OF];
    });
  return { messages, checklists };
}
