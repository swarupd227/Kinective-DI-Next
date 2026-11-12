// ESP alignment, step 1: who opened each account and where it was originated (ESP stamps openedByEmpNumber,
// openBranch and originatingBranch on its loan and share rows), and each person's credit score history
// (ESP's esp_crm_creditscorehistory, with a score type). Kept in tables of their own beside cdm_loan and
// cdm_deposit_account so nothing that reads those tables changes. Drawn with unit() on salts of their
// own, so no existing seeded figure moves.
import { AS_OF, unit } from './generate.ts';

export const ESP_ORIGINATION_DDL = [
  `CREATE TABLE cdm_account_origination (account_kind VARCHAR(8) NOT NULL, account_id INT NOT NULL, opened_by_employee_id INT NULL, originating_branch_id INT NOT NULL, channel VARCHAR(20) NOT NULL, PRIMARY KEY (account_kind, account_id), KEY ix_orig_emp (opened_by_employee_id))`,
  `CREATE TABLE cdm_credit_score_history (party_id INT NOT NULL, as_of DATE NOT NULL, score_type VARCHAR(20) NOT NULL, score SMALLINT NOT NULL, source VARCHAR(30) NOT NULL, PRIMARY KEY (party_id, as_of, score_type), KEY ix_score_asof (as_of))`,
];

const ymd = (d: number) => new Date(d).toISOString().slice(0, 10);
const DAY = 86_400_000;
const day = (v: unknown) => (v instanceof Date ? v.toISOString() : String(v)).slice(0, 10);

/**
 * employees: cdm_employee rows [id, name, role, branch]; loans: cdm_loan rows (id, party, branch, officer,
 * category, indirect, open, ..., credit_score at 13); deposits: cdm_deposit_account rows (id, party, branch, ..., open at 4).
 */
export function generateOrigination(employees: unknown[][], branchCount: number, loans: unknown[][], deposits: unknown[][]) {
  const staff = (branch: number, roles: string[]) => employees.filter((e) => e[3] === branch && roles.includes(String(e[2]))).map((e) => e[0] as number);
  const origination: unknown[][] = [];
  for (const l of loans) {
    const id = l[0] as number;
    const branch = l[2] as number;
    const indirect = Number(l[5]) === 1;
    // A loan is usually originated where it's serviced; about one in eight starts at another branch.
    const moved = !indirect && unit(id, 2101) < 0.12;
    const origin = moved ? 1 + ((branch + Math.floor(unit(id, 2102) * (branchCount - 1))) % branchCount) : branch;
    // The officer who booked it, or for an indirect loan no employee: the dealer took the application.
    const opener = indirect ? null : moved ? (staff(origin, ['Loan officer'])[Math.floor(unit(id, 2103) * 2)] ?? (l[3] as number)) : (l[3] as number);
    origination.push(['loan', id, opener, origin, indirect ? 'Dealer' : unit(id, 2104) < 0.22 ? 'Online' : 'Branch']);
  }
  for (const d of deposits) {
    const id = d[0] as number;
    const branch = d[2] as number;
    const online = unit(id, 2111) < 0.18;
    const moved = !online && unit(id, 2112) < 0.08;
    const origin = moved ? 1 + ((branch + Math.floor(unit(id, 2113) * (branchCount - 1))) % branchCount) : branch;
    const tellers = staff(origin, ['MSR', 'Branch manager']);
    origination.push(['deposit', id, online ? null : (tellers[Math.floor(unit(id, 2114) * tellers.length)] ?? null), origin, online ? 'Online' : 'Branch']);
  }

  // Credit scores: each loan's score at application, then quarterly soft pulls for people with an open
  // loan over the last six quarters. Most drift a few points; some slide, the early-warning case.
  const asOf = Date.parse(`${AS_OF}T00:00:00Z`);
  const byParty = new Map<number, { score: number; at: string; open: boolean }[]>();
  for (const l of loans) {
    if (l[13] === null || l[13] === undefined) continue;
    const party = l[1] as number;
    const list = byParty.get(party) ?? byParty.set(party, []).get(party)!;
    list.push({ score: Number(l[13]), at: day(l[6]), open: l[7] === null && l[8] === null });
  }
  const history: unknown[][] = [];
  const seen = new Set<string>();
  const add = (party: number, at: string, type: string, score: number, source: string) => {
    const key = `${party}|${at}|${type}`;
    if (seen.has(key)) return;
    seen.add(key);
    history.push([party, at, type, Math.max(300, Math.min(850, Math.round(score))), source]);
  };
  const quarterEnds = Array.from({ length: 6 }, (_, i) => {
    const d = new Date(asOf);
    const q = Math.floor(d.getUTCMonth() / 3) - i;
    const y = d.getUTCFullYear() + Math.floor(q / 4);
    const m = ((q % 4) + 4) % 4;
    return ymd(Date.UTC(y, m * 3, 0));
  }).reverse();
  for (const [party, list] of byParty) {
    for (const x of list) add(party, x.at, 'FICO 8', x.score, 'Loan application');
    if (!list.some((x) => x.open)) continue;
    const latest = [...list].sort((a, b) => b.at.localeCompare(a.at))[0]!;
    const sliding = unit(party, 2121) < 0.07;
    let s = latest.score;
    for (const [i, q] of quarterEnds.entries()) {
      if (q <= latest.at) continue;
      s += sliding ? -(8 + unit(party * 7 + i, 2122) * 22) : (unit(party * 7 + i, 2123) - 0.5) * 18;
      add(party, q, 'FICO 8', s, 'Quarterly soft pull');
    }
    if (unit(party, 2124) < 0.25) add(party, quarterEnds.at(-1)!, 'VantageScore 3.0', s + (unit(party, 2125) - 0.5) * 30, 'Quarterly soft pull');
  }
  return { origination, history };
}
