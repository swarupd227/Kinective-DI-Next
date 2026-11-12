// ESP alignment, step 4: loan and share transactions with their codes (ESP's esp_finbi_loantransdata and
// sharetransdata, with transCode, transSource and feeType), for the last 30 days. Tables of their own;
// the credit union's checking transactions (cdm_transaction, used by loan growth) are untouched. Drawn
// with unit() on salts of their own, so no existing figure moves.
import { AS_OF, unit } from './generate.ts';

export const ESP_TXN_DDL = [
  `CREATE TABLE cdm_transaction_code (code VARCHAR(12) PRIMARY KEY, description VARCHAR(60) NOT NULL, direction VARCHAR(6) NOT NULL, fee_type VARCHAR(30) NULL)`,
  `CREATE TABLE cdm_share_transaction (txn_id INT PRIMARY KEY, account_id INT NOT NULL, party_id INT NOT NULL, posted DATE NOT NULL, code VARCHAR(12) NOT NULL, amount DECIMAL(12,2) NOT NULL, channel VARCHAR(12) NOT NULL, branch_id INT NULL, KEY ix_stxn_party (party_id, posted), KEY ix_stxn_posted (posted))`,
  `CREATE TABLE cdm_loan_transaction (txn_id INT PRIMARY KEY, loan_id INT NOT NULL, party_id INT NOT NULL, posted DATE NOT NULL, code VARCHAR(12) NOT NULL, amount DECIMAL(12,2) NOT NULL, principal DECIMAL(12,2) NOT NULL, interest DECIMAL(12,2) NOT NULL, channel VARCHAR(12) NOT NULL, KEY ix_ltxn_party (party_id, posted))`,
];

export const TXN_CODES: [code: string, description: string, direction: 'Debit' | 'Credit', fee: string | null][] = [
  ['POS', 'Debit card purchase', 'Debit', null],
  ['ATMW', 'ATM withdrawal', 'Debit', null],
  ['ACHC', 'ACH deposit', 'Credit', null],
  ['ACHD', 'ACH payment', 'Debit', null],
  ['TLRD', 'Teller deposit', 'Credit', null],
  ['TLRW', 'Teller withdrawal', 'Debit', null],
  ['MRDC', 'Mobile check deposit', 'Credit', null],
  ['XFER', 'Online transfer', 'Debit', null],
  ['BILL', 'Bill payment', 'Debit', null],
  ['DIV', 'Dividend or interest credit', 'Credit', null],
  ['FEE-OD', 'Overdraft fee', 'Debit', 'Overdraft'],
  ['FEE-MNT', 'Monthly maintenance fee', 'Debit', 'Maintenance'],
  ['FEE-ATM', 'Out-of-network ATM fee', 'Debit', 'ATM'],
  ['LNPMT', 'Loan payment', 'Credit', null],
  ['LNLATE', 'Late payment fee', 'Debit', 'Late payment'],
];
const CHANNEL: Record<string, string> = { POS: 'Card', ATMW: 'ATM', ACHC: 'ACH', ACHD: 'ACH', TLRD: 'Teller', TLRW: 'Teller', MRDC: 'Mobile', XFER: 'Online', BILL: 'Online', DIV: 'System', 'FEE-OD': 'System', 'FEE-MNT': 'System', 'FEE-ATM': 'ATM' };

const DAY = 86_400_000;
const r2 = (n: number) => Math.round(n * 100) / 100;
const ymd = (d: number) => new Date(d).toISOString().slice(0, 10);

/**
 * deposits: cdm_deposit_account rows (id, party, branch, category, open, close, maturity, balance, rate);
 * loans: cdm_loan rows (id, party, branch, officer, category, indirect, open, close, chargeoff, original,
 * balance, rate, days_delinquent, ..., term at 15); fees: monthly fee by deposit account (from its product).
 */
export function generateTransactions30(deposits: unknown[][], loans: unknown[][], fees: Map<number, number>) {
  const end = Date.parse(`${AS_OF}T00:00:00Z`);
  const start = end - 29 * DAY;
  const share: unknown[][] = [];
  const loan: unknown[][] = [];
  let id = 1;
  const day = (seed: number, salt: number) => ymd(start + Math.floor(unit(seed, salt) * 30) * DAY);
  for (const d of deposits) {
    if (d[5] !== null) continue;
    const acct = d[0] as number;
    const party = d[1] as number;
    const branch = d[2] as number;
    const cat = String(d[3]);
    const bal = Number(d[7]);
    const add = (k: number, code: string, amount: number) => share.push([id++, acct, party, day(acct * 31 + k, 2301), code, r2(amount), CHANNEL[code] ?? 'System', CHANNEL[code] === 'Teller' ? branch : null]);
    if (cat === 'Checking') {
      const n = 3 + Math.floor(unit(acct, 2302) * 12);
      const mix = ['POS', 'POS', 'POS', 'ATMW', 'ACHD', 'BILL', 'XFER', 'TLRW', 'ACHC', 'MRDC', 'TLRD'];
      for (let k = 0; k < n; k++) {
        const code = mix[Math.floor(unit(acct * 31 + k, 2303) * mix.length)]!;
        const credit = code === 'ACHC' || code === 'MRDC' || code === 'TLRD';
        const size = code === 'ACHC' ? 900 + unit(acct + k, 2304) * 2400 : code === 'POS' ? 8 + unit(acct + k, 2304) * 140 : 40 + unit(acct + k, 2304) * 460;
        add(k, code, credit ? size : -size);
      }
      if (unit(acct, 2305) < 0.04) add(90, 'FEE-OD', -32);
      if (unit(acct, 2306) < 0.1) add(91, 'FEE-ATM', -3);
      const fee = fees.get(acct) ?? 0;
      if (fee > 0 && unit(acct, 2307) < 0.55) add(92, 'FEE-MNT', -fee);
    } else if (cat === 'Share Savings' || cat === 'Savings' || cat === 'Money Market') {
      if (unit(acct, 2308) < 0.45) add(0, unit(acct, 2309) < 0.5 ? 'XFER' : 'TLRD', unit(acct, 2309) < 0.5 ? -(50 + unit(acct, 2310) * 500) : 50 + unit(acct, 2310) * 800);
      add(1, 'DIV', (bal * Number(d[8])) / 100 / 12);
      const fee = fees.get(acct) ?? 0;
      if (fee > 0 && unit(acct, 2311) < 0.3) add(92, 'FEE-MNT', -fee);
    } else add(1, 'DIV', (bal * Number(d[8])) / 100 / 12);
  }
  for (const l of loans) {
    const bal = Number(l[10]);
    if (l[7] !== null || l[8] !== null || bal <= 0) continue;
    const lid = l[0] as number;
    const interest = r2((bal * Number(l[11])) / 100 / 12);
    const term = Number(l[15] ?? 60) || 60;
    const principal = r2(Math.min(bal, bal / Math.max(6, term / 2)));
    const ch = unit(lid, 2312) < 0.55 ? 'ACH' : unit(lid, 2312) < 0.85 ? 'Online' : 'Teller';
    loan.push([id++, lid, l[1], day(lid, 2313), 'LNPMT', r2(principal + interest), principal, interest, ch]);
    if (Number(l[12]) >= 30 && unit(lid, 2314) < 0.6) loan.push([id++, lid, l[1], day(lid, 2315), 'LNLATE', -25, 0, 0, 'System']);
  }
  return { codes: TXN_CODES.map((c) => [...c]), share, loan };
}
