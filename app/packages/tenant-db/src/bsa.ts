// BSA/AML and fraud for a bank: what the BSA officer's case system and the fraud team record. Transaction
// monitoring alerts and their dispositions, SARs with the date the activity was detected and the date
// filed (31 CFR 1020.320 gives 30 days, and continuing activity is reviewed every 90 days), CTRs (15
// days), OFAC screening, the high-risk customers due for review, fraud cases and losses, and the program
// items examiners test: the risk assessment, the independent test's findings and training.
import { AS_OF } from './generate.ts';

export const BSA_DDL = [
  `CREATE TABLE bsa_alert (
     alert_id INT PRIMARY KEY,
     opened DATE NOT NULL,
     source VARCHAR(30) NOT NULL,
     typology VARCHAR(40) NOT NULL,
     party_id INT NOT NULL,
     amount DECIMAL(14,2) NOT NULL,
     status VARCHAR(20) NOT NULL,
     closed DATE NULL,
     sar_id INT NULL,
     KEY ix_alert_status (status, opened)
   )`,
  `CREATE TABLE bsa_sar (
     sar_id INT PRIMARY KEY,
     detected_on DATE NOT NULL,
     filed_on DATE NOT NULL,
     typology VARCHAR(40) NOT NULL,
     amount DECIMAL(14,2) NOT NULL,
     continuing TINYINT NOT NULL,
     party_id INT NOT NULL,
     next_review DATE NULL,
     reviewed_on DATE NULL
   )`,
  `CREATE TABLE bsa_ctr (month DATE PRIMARY KEY, filed INT NOT NULL, late INT NOT NULL, exempt_customers INT NOT NULL)`,
  `CREATE TABLE bsa_ofac (month DATE PRIMARY KEY, screened INT NOT NULL, potential INT NOT NULL, true_matches INT NOT NULL, blocked_amount DECIMAL(14,2) NOT NULL, rejected_amount DECIMAL(14,2) NOT NULL)`,
  `CREATE TABLE bsa_customer_risk (
     party_id INT PRIMARY KEY,
     rating VARCHAR(12) NOT NULL,
     category VARCHAR(60) NOT NULL,
     last_review DATE NOT NULL,
     next_review DATE NOT NULL
   )`,
  `CREATE TABLE fraud_case (
     case_id INT PRIMARY KEY,
     opened DATE NOT NULL,
     fraud_type VARCHAR(40) NOT NULL,
     channel VARCHAR(20) NOT NULL,
     party_id INT NOT NULL,
     gross_loss DECIMAL(12,2) NOT NULL,
     recovered DECIMAL(12,2) NOT NULL,
     prevented DECIMAL(12,2) NOT NULL,
     elder TINYINT NOT NULL,
     status VARCHAR(20) NOT NULL
   )`,
  `CREATE TABLE bsa_program (
     item VARCHAR(60) PRIMARY KEY,
     area VARCHAR(30) NOT NULL,
     status VARCHAR(20) NOT NULL,
     as_of DATE NOT NULL,
     due DATE NULL,
     detail VARCHAR(300) NOT NULL
   )`,
];

const unit = (id: number, salt: number) => {
  let h = (id * 2654435761 + salt * 40503) >>> 0;
  h ^= h >>> 16;
  h = Math.imul(h, 2246822507) >>> 0;
  h ^= h >>> 13;
  h = Math.imul(h, 3266489909) >>> 0;
  h ^= h >>> 16;
  return (h >>> 0) / 4294967296;
};
const weighted = <T>(xs: readonly (readonly [T, number])[], u: number) => {
  let t = 0;
  for (const [x, w] of xs) {
    t += w;
    if (u < t) return x;
  }
  return xs.at(-1)![0];
};
const addDays = (d: string, n: number) => {
  const x = new Date(`${d}T00:00:00Z`);
  x.setUTCDate(x.getUTCDate() + n);
  return x.toISOString().slice(0, 10);
};
const r2 = (n: number) => Math.round(n * 100) / 100;

const TYPOLOGY: readonly (readonly [string, number])[] = [
  ['Structuring', 0.2],
  ['Elder financial exploitation', 0.14],
  ['Check fraud and kiting', 0.16],
  ['Rapid movement of funds', 0.12],
  ['Cash-intensive business activity', 0.1],
  ['Wire to a high-risk jurisdiction', 0.06],
  ['Account takeover', 0.08],
  ['Scam payments (P2P and wire)', 0.14],
];
const SOURCE: readonly (readonly [string, number])[] = [['Transaction monitoring', 0.78], ['Employee referral', 0.12], ['Fraud team', 0.08], ['314(a) match', 0.02]];
const FRAUD: readonly (readonly [[string, string, number], number])[] = [
  [['Check fraud (altered or counterfeit)', 'Check', 3_100], 0.26],
  [['Debit card fraud', 'Card', 240], 0.31],
  [['Scam: P2P and Zelle', 'P2P', 850], 0.15],
  [['Scam: wire (business email compromise)', 'Wire', 24_000], 0.01],
  [['Account takeover', 'Online', 2_300], 0.1],
  [['ACH fraud', 'ACH', 1_500], 0.09],
  [['Loan fraud (synthetic identity)', 'Loan', 5_200], 0.04],
  [['Elder exploitation by a known person', 'Branch', 4_100], 0.04],
];

/** The months on file: October 2025 to October 2026. */
const MONTHS = Array.from({ length: 13 }, (_, i) => {
  const d = new Date(Date.UTC(2025, 9 + i, 1));
  return d.toISOString().slice(0, 10);
});

export function generateBsa(partyCount: number) {
  const party = (i: number, salt: number) => 1 + Math.floor(unit(i, salt) * partyCount);
  // Alerts: about 150 a month. Most close without a SAR; about one in twenty ends in one.
  const alerts: unknown[][] = [];
  const sars: unknown[][] = [];
  let sarId = 1;
  let lateDone = false;
  let id = 1;
  for (const m of MONTHS) {
    const n = 135 + Math.floor(unit(Number(m.slice(0, 7).replace('-', '')), 1) * 35);
    for (let k = 0; k < n; k++, id++) {
      const opened = addDays(m, Math.floor(unit(id, 2) * 28));
      if (opened > AS_OF) continue;
      const typology = weighted(TYPOLOGY, unit(id, 3));
      const source = weighted(SOURCE, unit(id, 4));
      const amount = r2(4_000 + unit(id, 5) ** 2 * 180_000);
      const age = (Date.parse(AS_OF) - Date.parse(opened)) / 86_400_000;
      // Recent alerts are still being worked; a few older ones have sat too long.
      const open = age < 20 ? unit(id, 6) < 0.75 : age < 60 ? unit(id, 6) < 0.12 : unit(id, 6) < 0.004;
      if (open) {
        alerts.push([id, opened, source, typology, party(id, 7), amount, age > 30 ? 'Escalated' : 'Open', null, null]);
        continue;
      }
      const sar = unit(id, 8) < (source === 'Transaction monitoring' ? 0.042 : 0.2);
      const closed = addDays(opened, 4 + Math.floor(unit(id, 9) * 18));
      if (sar) {
        // Detected when the alert's review found the activity suspicious; filed within 30 days, with one late in the third quarter.
        const detected = addDays(opened, 2 + Math.floor(unit(id, 10) * 8));
        // One SAR in July went past the 30 days: the case sat while its analyst was out.
        const late = !lateDone && detected >= '2026-07-01' && detected < '2026-08-01';
        if (late) lateDone = true;
        const filed = addDays(detected, late ? 38 : 9 + Math.floor(unit(id, 11) * 19));
        const continuing = unit(id, 12) < 0.18 ? 1 : 0;
        const next = continuing ? addDays(filed, 90) : null;
        const reviewed = continuing && next && next < addDays(AS_OF, -20) && unit(id, 13) < 0.7 ? addDays(next, -3) : null;
        sars.push([sarId, detected, filed, typology, amount, continuing, party(id, 7), next, reviewed]);
        alerts.push([id, opened, source, typology, party(id, 7), amount, 'SAR filed', filed, sarId]);
        sarId++;
      } else alerts.push([id, opened, source, typology, party(id, 7), amount, 'Closed - no SAR', closed, null]);
    }
  }
  const ctr = MONTHS.filter((m) => m <= AS_OF).map((m, i) => [m, 88 + Math.floor(unit(i, 20) * 30), 0, 41]);
  const ofac = MONTHS.filter((m) => m <= AS_OF).map((m, i) => [m, 61_000 + Math.floor(unit(i, 21) * 9_000), 18 + Math.floor(unit(i, 22) * 14), m === '2026-06-01' ? 1 : 0, m === '2026-06-01' ? 4_800 : 0, m === '2026-02-01' ? 12_500 : 0]);
  // High-risk and elevated customers: reviewed every 12 months (high) or 24 (elevated); some are overdue.
  const risk: unknown[][] = [];
  const cats: readonly (readonly [string, number])[] = [['Cash-intensive business', 0.34], ['Money services business', 0.06], ['Nonresident alien', 0.12], ['Politically exposed person', 0.04], ['Third-party payment processor', 0.03], ['Private ATM operator', 0.05], ['Marijuana-related business (state-licensed)', 0.02], ['Foreign correspondent activity', 0.04], ['Charity or nonprofit', 0.3]];
  for (let i = 1; i <= 412; i++) {
    const high = unit(i, 30) < 0.24;
    const last = addDays(AS_OF, -Math.floor(unit(i, 31) * (high ? 400 : 760)));
    risk.push([party(i, 32), high ? 'High' : 'Elevated', weighted(cats, unit(i, 33)), last, addDays(last, high ? 365 : 730)]);
  }
  const seen = new Set<number>();
  const riskRows = risk.filter((r) => (seen.has(r[0] as number) ? false : (seen.add(r[0] as number), true)));
  // Fraud cases: about 90 a month, check fraud rising through the year.
  const fraud: unknown[][] = [];
  let caseId = 1;
  MONTHS.forEach((m, mi) => {
    const n = 78 + mi * 2 + Math.floor(unit(mi, 40) * 15);
    for (let k = 0; k < n; k++, caseId++) {
      const opened = addDays(m, Math.floor(unit(caseId, 41) * 28));
      if (opened > AS_OF) continue;
      const tilt = unit(caseId, 42) < 0.06 + mi * 0.008 ? 0 : 1;
      const [type, channel, typical] = tilt === 0 ? FRAUD[0]![0] : weighted(FRAUD, unit(caseId, 43));
      const attempted = r2(typical * (0.3 + unit(caseId, 44) * 1.6));
      // Some fraud is stopped before money leaves; of what's lost, part is recovered (chargebacks, returns, restitution).
      const stopped = unit(caseId, 45) < (channel === 'Card' ? 0.55 : channel === 'Wire' ? 0.3 : 0.35);
      const gross = stopped ? 0 : attempted;
      const recovered = r2(gross * (channel === 'Card' ? 0.55 : channel === 'Check' ? 0.3 : channel === 'Wire' ? 0.12 : 0.2) * unit(caseId, 46) * 2);
      const elder = type.startsWith('Elder') || (type.startsWith('Scam') && unit(caseId, 47) < 0.45) ? 1 : 0;
      fraud.push([caseId, opened, type, channel, party(caseId, 48), gross, Math.min(gross, recovered), stopped ? attempted : 0, elder, Date.parse(AS_OF) - Date.parse(opened) < 30 * 86_400_000 ? 'Open' : 'Closed']);
    }
  });
  const program = [
    ['BSA/AML risk assessment', 'Program', 'Current', '2026-04-22', '2027-04-30', 'Updated for the new P2P product and the state-licensed cannabis customers; approved by the board in May.'],
    ['Independent test', 'Program', 'Findings open', '2026-03-18', null, 'Independent test by Moss Adams: 3 findings. Two closed. Open: alerts older than 30 days in the third quarter of 2025 (due September 30, 2026, past due).'],
    ['BSA officer', 'Program', 'Current', '2025-01-15', null, 'Jordan Blake, appointed by the board in January 2025; reports to the audit committee quarterly.'],
    ['Training', 'Training', 'In progress', AS_OF, '2026-12-15', '94% of employees completed 2026 BSA/AML and OFAC training; the board’s session is December 9.'],
    ['Beneficial ownership refresh', 'Customer due diligence', 'In progress', AS_OF, '2026-12-31', '37 legal entity customers have beneficial ownership certifications more than three years old.'],
    ['314(a) searches', 'Information sharing', 'Current', '2026-10-21', null, 'Every FinCEN 314(a) list searched within 14 days; one match this year, reported.'],
    ['Model validation: transaction monitoring', 'Program', 'Due', '2024-11-05', '2026-11-30', 'Rules and thresholds were last tuned and validated in November 2024; due again by November 30.'],
  ];
  return { alerts, sars, ctr, ofac, risk: riskRows, fraud, program };
}
