// Operational and cyber risk for a bank: the information security officer's register. Incidents (and
// whether a notification incident reached the regulator within 36 hours, 12 CFR 304 Subpart C), critical
// vendors and their SOC reports, controls by NIST Cybersecurity Framework 2.0 function, monthly security
// measures, resilience tests against recovery-time targets, and the cyber insurance policy.
import { AS_OF } from './generate.ts';

export const OPRISK_DDL = [
  `CREATE TABLE ops_incident (
     incident_id INT PRIMARY KEY,
     opened DATE NOT NULL,
     category VARCHAR(40) NOT NULL,
     severity TINYINT NOT NULL,
     summary VARCHAR(200) NOT NULL,
     downtime_minutes INT NOT NULL,
     customers_affected INT NOT NULL,
     loss DECIMAL(12,2) NOT NULL,
     notification_incident TINYINT NOT NULL,
     determined_at DATETIME NULL,
     notified_at DATETIME NULL,
     status VARCHAR(20) NOT NULL
   )`,
  `CREATE TABLE ops_vendor (
     vendor VARCHAR(60) PRIMARY KEY,
     service VARCHAR(80) NOT NULL,
     criticality VARCHAR(12) NOT NULL,
     last_review DATE NOT NULL,
     next_review DATE NOT NULL,
     soc_report_date DATE NULL,
     soc_opinion VARCHAR(20) NULL,
     exit_plan TINYINT NOT NULL,
     note VARCHAR(200) NULL
   )`,
  `CREATE TABLE ops_control (
     control VARCHAR(80) PRIMARY KEY,
     csf_function VARCHAR(12) NOT NULL,
     status VARCHAR(12) NOT NULL,
     target_date DATE NULL,
     note VARCHAR(200) NULL
   )`,
  `CREATE TABLE ops_metric (
     month DATE NOT NULL,
     metric VARCHAR(40) NOT NULL,
     value DECIMAL(10,2) NOT NULL,
     PRIMARY KEY (month, metric)
   )`,
  `CREATE TABLE ops_test (
     test VARCHAR(80) PRIMARY KEY,
     kind VARCHAR(30) NOT NULL,
     tested_on DATE NOT NULL,
     result VARCHAR(20) NOT NULL,
     rto_target_hours DECIMAL(6,1) NULL,
     rto_actual_hours DECIMAL(6,1) NULL,
     findings_open INT NOT NULL,
     note VARCHAR(200) NULL
   )`,
  `CREATE TABLE ops_insurance (
     coverage VARCHAR(60) PRIMARY KEY,
     carrier VARCHAR(60) NOT NULL,
     limit_amount DECIMAL(14,2) NOT NULL,
     retention DECIMAL(12,2) NOT NULL,
     premium DECIMAL(12,2) NOT NULL,
     renewal DATE NOT NULL,
     note VARCHAR(200) NULL
   )`,
];

const at = (d: string, h: number) => `${d} ${String(h).padStart(2, '0')}:00:00`;

export function generateOpRisk() {
  const incidents: unknown[][] = [
    [1, '2025-11-04', 'Phishing', 3, 'Credential phishing reached 41 inboxes; 2 employees entered passwords, reset within the hour', 0, 0, 0, 0, null, null, 'Closed'],
    [2, '2025-12-12', 'Vendor outage', 2, 'Card processor outage: debit cards declined for 3 hours on a Friday evening', 180, 9_400, 6_200, 0, null, null, 'Closed'],
    [3, '2026-01-20', 'DDoS', 3, 'Online banking slowed by a denial-of-service attack; mitigated by the hosting provider', 45, 0, 0, 0, null, null, 'Closed'],
    [4, '2026-02-17', 'Business email compromise', 2, 'Spoofed vendor invoice: wire of $86,000 stopped by callback verification', 0, 0, 0, 0, null, null, 'Closed'],
    [5, '2026-03-09', 'Malware', 3, 'Infostealer on a branch workstation caught by endpoint detection; no data left', 0, 0, 0, 0, null, null, 'Closed'],
    [6, '2026-04-28', 'Core outage', 1, 'Core processing outage from the provider’s failed upgrade: branches and online banking down 7 hours', 420, 31_000, 18_500, 1, at('2026-04-28', 11), at('2026-04-29', 9), 'Closed'],
    [7, '2026-06-03', 'Phishing', 3, 'Text-message phishing impersonating the bank to customers; takedown in 6 hours', 0, 1_200, 4_300, 0, null, null, 'Closed'],
    [8, '2026-07-22', 'Data exposure', 2, 'Statement vendor mailed 212 statements to old addresses; vendor root cause and remediation', 0, 212, 3_900, 0, null, null, 'Closed'],
    [9, '2026-08-14', 'Ransomware attempt', 1, 'Ransomware detonated on two servers through a vendor’s remote access; contained before encryption spread, restored from immutable backups', 310, 0, 142_000, 1, at('2026-08-14', 16), at('2026-08-16', 10), 'Closed'],
    [10, '2026-09-30', 'Vendor outage', 2, 'Bill pay provider down 2 days at month end', 2_880, 3_100, 0, 0, null, null, 'Closed'],
    [11, '2026-10-17', 'Phishing', 3, 'Payroll-themed phishing campaign; 6 clicks, no credentials entered', 0, 0, 0, 0, null, null, 'Open'],
  ];
  const vendors: unknown[][] = [
    ['Fiserv (core processing)', 'Core banking, online and mobile', 'Critical', '2026-03-15', '2027-03-15', '2026-02-28', 'Unqualified', 1, 'Upgrade failure in April caused the 7-hour outage; contract renews 2028.'],
    ['FIS (card processing)', 'Debit card authorization and settlement', 'Critical', '2025-09-10', '2026-09-10', '2025-12-31', 'Unqualified', 1, 'Annual review overdue since September 10.'],
    ['Jack Henry (bill pay)', 'Bill payment', 'High', '2026-05-02', '2027-05-02', '2026-03-31', 'Qualified', 0, 'SOC 2 qualified for change management; no exit plan on file.'],
    ['Arctic Wolf (managed detection)', '24/7 security monitoring and response', 'Critical', '2026-06-20', '2027-06-20', '2026-04-30', 'Unqualified', 1, null],
    ['Microsoft 365', 'Email, files and identity', 'Critical', '2026-01-12', '2027-01-12', '2026-03-31', 'Unqualified', 0, 'Single identity provider for every employee login.'],
    ['DocuPrint Services', 'Statements and notices', 'High', '2026-08-01', '2027-08-01', '2025-11-30', 'Unqualified', 1, 'Mis-mailing in July; corrective plan accepted.'],
    ['Vertex IT (managed services)', 'Network and server administration, remote access', 'Critical', '2025-11-20', '2026-11-20', null, null, 0, 'Its remote access was the ransomware entry point in August; review due November 20.'],
    ['Q2 (digital banking)', 'Online and mobile banking platform', 'Critical', '2026-02-14', '2027-02-14', '2026-01-31', 'Unqualified', 1, null],
    ['Abrigo (BSA and CECL)', 'BSA case management and CECL model', 'High', '2026-04-10', '2027-04-10', '2026-03-31', 'Unqualified', 1, null],
  ];
  const controls: unknown[][] = [
    ['Cybersecurity risk governance and board reporting', 'Govern', 'Met', null, 'Quarterly report to the board; the CISO presents twice a year.'],
    ['Third-party risk management program', 'Govern', 'Partial', '2026-12-31', 'Two critical vendors overdue or without a SOC report.'],
    ['Asset inventory, hardware and software', 'Identify', 'Met', null, null],
    ['Annual cyber risk assessment', 'Identify', 'Met', null, 'Updated in March after the CRI Profile self-assessment.'],
    ['Multifactor authentication: employees and remote access', 'Protect', 'Partial', '2026-12-15', 'All employees enrolled; three vendor remote-access accounts still on passwords.'],
    ['Multifactor authentication: customers (online banking)', 'Protect', 'Met', null, null],
    ['Privileged access management', 'Protect', 'Partial', '2027-03-31', 'Vaulting covers servers; network devices next.'],
    ['Critical patches within 30 days', 'Protect', 'Partial', null, 'See the monthly measure: 88% in October against a 95% target.'],
    ['Security awareness training and phishing tests', 'Protect', 'Met', null, null],
    ['Endpoint detection and response on every device', 'Detect', 'Met', null, null],
    ['24/7 monitoring and alerting', 'Detect', 'Met', null, 'Managed detection by Arctic Wolf.'],
    ['Incident response plan, tested', 'Respond', 'Met', null, 'Ransomware tabletop in June; used for real in August.'],
    ['Regulator notification within 36 hours', 'Respond', 'Partial', null, 'Met for April; the August incident was notified after 42 hours.'],
    ['Immutable, offline backups', 'Recover', 'Met', null, 'Restored the August servers within 5 hours.'],
    ['Core and critical system recovery tested against targets', 'Recover', 'Partial', '2027-02-28', 'Core failover last ran in March and missed its 4-hour target.'],
  ];
  const months = Array.from({ length: 12 }, (_, i) => new Date(Date.UTC(2025, 10 + i, 1)).toISOString().slice(0, 10)).filter((m) => m <= AS_OF);
  const metrics: unknown[][] = [];
  months.forEach((m, i) => {
    metrics.push([m, 'phishing_click_pct', [6.8, 6.1, 5.9, 5.2, 4.8, 4.6, 4.1, 3.9, 3.6, 3.8, 3.1, 2.9][i] ?? 3]);
    metrics.push([m, 'critical_patch_30d_pct', [91, 93, 90, 94, 92, 95, 96, 89, 93, 94, 91, 88][i] ?? 90]);
    metrics.push([m, 'mfa_coverage_pct', [92, 93, 95, 96, 97, 97, 98, 98, 99, 99, 99, 99][i] ?? 99]);
    metrics.push([m, 'edr_coverage_pct', [97, 98, 98, 99, 99, 100, 100, 100, 100, 100, 100, 100][i] ?? 100]);
    metrics.push([m, 'training_complete_pct', [100, 100, 12, 31, 48, 62, 71, 80, 86, 90, 93, 94][i] ?? 94]);
  });
  const tests: unknown[][] = [
    ['Core processing failover to the provider’s second data center', 'DR failover', '2026-03-21', 'Partial', 4, 6.5, 2, 'Network routing change took 2.5 hours longer than planned; retest scheduled February 2027.'],
    ['Restore from immutable backup: file and application servers', 'Backup restore', '2026-08-15', 'Passed', 8, 5, 0, 'Done for real during the August ransomware attempt.'],
    ['Restore from immutable backup: quarterly test', 'Backup restore', '2026-09-26', 'Passed', 8, 4.5, 0, null],
    ['Ransomware tabletop with executives and the board’s risk committee', 'Tabletop', '2026-06-11', 'Passed', null, null, 1, 'Open: pre-authorize the incident response firm and counsel under the policy.'],
    ['Business continuity: branch and operations relocation', 'BCP test', '2026-05-07', 'Passed', 24, 18, 0, null],
    ['External penetration test', 'Penetration test', '2026-07-08', 'Findings', null, null, 3, 'Three medium findings open, due December 31.'],
    ['Wire room loss of the primary site', 'BCP test', '2025-12-03', 'Passed', 4, 3, 0, null],
  ];
  const insurance: unknown[][] = [
    ['Cyber liability (first and third party)', 'Beazley', 5_000_000, 250_000, 96_000, '2027-03-01', 'Aggregate limit for the policy year; the August ransomware costs ($142,000) fell within the retention, so nothing was claimed.'],
    ['Ransomware and extortion (sublimit)', 'Beazley', 2_500_000, 250_000, 0, '2027-03-01', 'Sublimit within the cyber policy; covers forensics, restoration and extortion payments where lawful.'],
    ['Business interruption from a cyber event', 'Beazley', 2_000_000, 250_000, 0, '2027-03-01', 'Twelve-hour waiting period; includes outages at a named critical vendor.'],
    ['Social engineering and funds transfer fraud (sublimit)', 'Beazley', 250_000, 25_000, 0, '2027-03-01', 'Business email compromise and spoofed instructions.'],
    ['Financial institution bond', 'Travelers', 10_000_000, 100_000, 61_000, '2027-01-01', 'Employee dishonesty, forgery, computer fraud; check fraud on customers’ accounts generally isn’t covered.'],
  ];
  return { incidents, vendors, controls, metrics, tests, insurance };
}
