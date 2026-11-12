// ESP alignment, step 5: who is on each account and in what role (ESP's accountdatacustomerdatalink with
// custType): the primary owner (the account's own party_id, as ESP's customerID), joint owners and
// co-borrowers from the same household, beneficiaries on certificates and IRAs, and authorized signers.
// A table of its own: every total keeps counting the primary owner only. Drawn with unit() on salts of
// their own, so no existing figure moves.
import { unit } from './generate.ts';

export const ESP_OWNER_DDL = [
  `CREATE TABLE cdm_account_owner (account_kind VARCHAR(8) NOT NULL, account_id INT NOT NULL, party_id INT NOT NULL, role VARCHAR(20) NOT NULL, PRIMARY KEY (account_kind, account_id, party_id), KEY ix_owner_party (party_id))`,
];

/** parties: cdm_party rows (household at 7); deposits: cdm_deposit_account rows (id, party, branch, category); loans: cdm_loan rows (id, party, branch, officer, category). */
export function generateOwners(parties: unknown[][], deposits: unknown[][], loans: unknown[][]) {
  const household = new Map<number, number>();
  const members = new Map<number, number[]>();
  for (const p of parties) {
    const id = p[0] as number;
    const h = p[7] as number;
    household.set(id, h);
    (members.get(h) ?? members.set(h, []).get(h)!).push(id);
  }
  const other = (party: number, seed: number, salt: number) => {
    const list = (members.get(household.get(party)!) ?? []).filter((x) => x !== party);
    return list.length ? list[Math.floor(unit(seed, salt) * list.length)]! : null;
  };
  const rows: unknown[][] = [];
  for (const d of deposits) {
    const id = d[0] as number;
    const party = d[1] as number;
    const cat = String(d[3]);
    rows.push(['deposit', id, party, 'Primary']);
    if ((cat === 'Checking' || cat.includes('Savings') || cat === 'Money Market') && unit(id, 2401) < 0.35) {
      const j = other(party, id, 2402);
      if (j !== null) rows.push(['deposit', id, j, 'Joint']);
    }
    if ((cat.startsWith('Certificates') || cat === 'IRA') && unit(id, 2403) < 0.4) {
      const b = other(party, id, 2404);
      if (b !== null) rows.push(['deposit', id, b, 'Beneficiary']);
    }
    if (cat === 'Checking' && unit(id, 2405) < 0.03) {
      const a = other(party, id, 2406);
      if (a !== null && !rows.some((r) => r[0] === 'deposit' && r[1] === id && r[2] === a)) rows.push(['deposit', id, a, 'Authorized signer']);
    }
  }
  for (const l of loans) {
    const id = l[0] as number;
    const party = l[1] as number;
    const cat = String(l[4]);
    rows.push(['loan', id, party, 'Primary']);
    if ((cat === 'Mortgage' || cat === 'Auto' || cat === 'HELOC') && unit(id, 2411) < 0.25) {
      const c = other(party, id, 2412);
      if (c !== null) rows.push(['loan', id, c, 'Co-borrower']);
    }
  }
  return rows;
}
