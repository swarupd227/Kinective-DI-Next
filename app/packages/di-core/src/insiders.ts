// Insider lending (ESP phase 2): loans to directors, committee members, executive officers, principal
// shareholders and employees. A bank answers to Regulation O (12 CFR 215): prior board approval above the
// greater of $25,000 or 5% of capital (never more than $500,000), each insider within the lending limit
// (15% of capital) and all insiders together within capital. A credit union answers to NCUA 701.21(d): the
// board approves loans to an official once the official's loans and lines pass $20,000. Every figure is
// worked out here; the agent only words it.
import type { Pool } from '@dinext/tenant-db';

const rows = async <T>(pool: Pool, sql: string, params: unknown[] = []) => (await pool.query(sql, params))[0] as T[];
const day = (v: unknown) => (v instanceof Date ? v.toISOString() : String(v ?? '')).slice(0, 10);

export const approvalThreshold = (bank: boolean, capital: number) => (bank ? Math.min(500_000, Math.max(25_000, capital * 0.05)) : 20_000);

export interface Insider {
  partyId: number;
  name: string;
  role: string;
  title: string;
  kind: 'Official' | 'Employee';
  since: string;
  until: string | null;
  loans: number;
  balance: number;
  committed: number;
  needsApproval: boolean;
  /** Loans made while an insider, over the threshold, with no board approval on record. */
  unapproved: { loanId: number; category: string; opened: string; original: number }[];
  overLendingLimit: boolean;
}

export class InsiderService {
  constructor(private readonly pool: Pool, private readonly institutionType: 'bank' | 'credit_union') {}

  async loans() {
    const has = await rows<{ n: number }>(this.pool, 'SELECT COUNT(*) AS n FROM cdm_insider').catch(() => null);
    if (!has) return null;
    const bank = this.institutionType === 'bank';
    // Capital for a bank's thresholds: equity capital on the latest Call Report.
    const [cap] = bank ? await rows<{ a: number }>(this.pool, "SELECT amount AS a FROM cr_value WHERE code = 'RCON3210' ORDER BY quarter_end DESC LIMIT 1").catch(() => []) : [];
    const capital = Number(cap?.a ?? 0);
    const threshold = approvalThreshold(bank, capital);
    const found = await rows<Record<string, unknown>>(
      this.pool,
      `SELECT i.party_id, p.first_name, p.last_name, i.role, i.title, i.since, i.until, il.kind, il.loan_id, il.effective_date, il.board_approved,
              l.loan_category, l.open_date, l.close_date, l.original_amount, l.balance
         FROM cdm_insider i JOIN cdm_party p ON p.party_id = i.party_id
         LEFT JOIN cdm_insider_loan il ON il.party_id = i.party_id
         LEFT JOIN cdm_loan l ON l.loan_id = il.loan_id
        ORDER BY i.party_id, l.open_date`,
    );
    const byParty = new Map<number, Insider>();
    for (const r of found) {
      const id = Number(r.party_id);
      let x = byParty.get(id);
      if (!x) {
        x = { partyId: id, name: `${r.first_name as string} ${r.last_name as string}`, role: r.role as string, title: r.title as string, kind: r.role === 'Employee' ? 'Employee' : 'Official', since: day(r.since), until: r.until ? day(r.until) : null, loans: 0, balance: 0, committed: 0, needsApproval: false, unapproved: [], overLendingLimit: false };
        byParty.set(id, x);
      }
      if (r.loan_id === null || r.loan_id === undefined || r.close_date) continue;
      x.loans += 1;
      x.balance += Number(r.balance);
      x.committed += Number(r.original_amount);
      if (x.kind === 'Official' && day(r.open_date) >= x.since && !r.board_approved) x.unapproved.push({ loanId: Number(r.loan_id), category: r.loan_category as string, opened: day(r.open_date), original: Number(r.original_amount) });
    }
    const insiders = [...byParty.values()];
    for (const x of insiders) {
      x.needsApproval = x.kind === 'Official' && x.committed > threshold;
      if (!x.needsApproval) x.unapproved = [];
      x.overLendingLimit = bank && capital > 0 && x.committed > capital * 0.15;
    }
    const current = insiders.filter((x) => !x.until);
    const officials = current.filter((x) => x.kind === 'Official');
    const employees = current.filter((x) => x.kind === 'Employee');
    const sum = (xs: Insider[]) => ({ people: xs.length, borrowers: xs.filter((x) => x.loans).length, loans: xs.reduce((s, x) => s + x.loans, 0), balance: xs.reduce((s, x) => s + x.balance, 0), committed: xs.reduce((s, x) => s + x.committed, 0) });
    const officialTotals = sum(officials);
    return {
      bank,
      rule: bank ? 'Regulation O (12 CFR 215)' : 'NCUA 701.21(d)',
      threshold,
      capital: bank ? capital : null,
      officials: officialTotals,
      employees: sum(employees),
      // Regulation O: all insiders' credit together may not exceed capital (215.4(d)).
      aggregateToCapital: bank && capital ? (officialTotals.committed / capital) * 100 : null,
      exceptions: officials.filter((x) => x.unapproved.length || x.overLendingLimit),
      needingApproval: officials.filter((x) => x.needsApproval).length,
      list: [...officials.sort((a, b) => b.committed - a.committed), ...employees.sort((a, b) => b.committed - a.committed)],
      former: insiders.filter((x) => x.until).length,
    };
  }
}
