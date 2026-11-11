// Predictive models (spec Predictive Analytics): what DI trains on and where it keeps the results.
// - hist_member_snapshot: each member as they stood at each month-end for the last 12 months: tenure,
//   products, balances and their 3-month change, direct deposit, logins, fees, contacts and complaints,
//   certificates maturing. Members who later left are included up to the month before they left, so a
//   model learns from how members looked before leaving, not after.
// - ml_model: every model DI trained, its version, training window, validation results and the feature
//   distributions it was trained on, and whether it's a candidate, the active one or retired.
// - ml_score: each member's score from each model at each month-end, with the reasons behind it.
// - ml_drift: how far this month's members have moved from what the model was trained on.
// The demo's members are generated, so the snapshots are too. Before leaving, members show what usually
// comes before it (a direct deposit stopped, balances drained, logins stopped, fees and complaints), more
// or less clearly depending on why they left; some show nothing, as real members often don't.
import type { GeneratedTenant } from './generate.ts';
import { AS_OF, unit } from './generate.ts';

export const ML_DDL = [
  `CREATE TABLE IF NOT EXISTS hist_member_snapshot (
     month_end DATE NOT NULL,
     party_id INT NOT NULL,
     branch_id INT NOT NULL,
     tenure_months SMALLINT NOT NULL,
     age TINYINT UNSIGNED NOT NULL,
     products TINYINT NOT NULL,
     has_checking TINYINT NOT NULL,
     has_loan TINYINT NOT NULL,
     deposit_balance DECIMAL(14,2) NOT NULL,
     balance_change_3m DECIMAL(7,3) NOT NULL,
     direct_deposit TINYINT NOT NULL,
     dd_stopped_90d TINYINT NOT NULL,
     days_since_login SMALLINT NOT NULL,
     fees_3m DECIMAL(8,2) NOT NULL,
     contacts_3m TINYINT NOT NULL,
     complaints_3m TINYINT NOT NULL,
     cert_maturing_90d TINYINT NOT NULL,
     PRIMARY KEY (month_end, party_id),
     KEY ix_snap_party (party_id)
   )`,
  `CREATE TABLE IF NOT EXISTS ml_model (
     model_id INT AUTO_INCREMENT PRIMARY KEY,
     name VARCHAR(40) NOT NULL,
     version INT NOT NULL,
     status VARCHAR(12) NOT NULL,
     algorithm VARCHAR(60) NOT NULL,
     target VARCHAR(120) NOT NULL,
     features JSON NOT NULL,
     params JSON NOT NULL,
     train_from DATE NOT NULL,
     train_to DATE NOT NULL,
     valid_from DATE NOT NULL,
     valid_to DATE NOT NULL,
     examples INT NOT NULL,
     positives INT NOT NULL,
     metrics JSON NOT NULL,
     baseline JSON NOT NULL,
     body MEDIUMTEXT NOT NULL,
     trained_by VARCHAR(80) NOT NULL,
     trained_at DATETIME NOT NULL,
     approved_by VARCHAR(80) NULL,
     approval_id VARCHAR(40) NULL,
     activated_at DATETIME NULL,
     UNIQUE KEY ux_model_version (name, version)
   )`,
  `CREATE TABLE IF NOT EXISTS ml_score (
     model_id INT NOT NULL,
     month_end DATE NOT NULL,
     party_id INT NOT NULL,
     item VARCHAR(60) NOT NULL DEFAULT '',
     probability DECIMAL(7,5) NOT NULL,
     probability_90d DECIMAL(7,5) NULL,
     expected_months DECIMAL(6,1) NULL,
     band VARCHAR(10) NOT NULL,
     drivers JSON NOT NULL,
     PRIMARY KEY (model_id, month_end, party_id, item),
     KEY ix_score_party (party_id, month_end)
   )`,
  `CREATE TABLE IF NOT EXISTS ml_drift (
     model_id INT NOT NULL,
     month_end DATE NOT NULL,
     feature VARCHAR(40) NOT NULL,
     psi DECIMAL(8,4) NOT NULL,
     PRIMARY KEY (model_id, month_end, feature)
   )`,
];

export const ML_WRITE_TABLES = ['ml_model', 'ml_score', 'ml_drift'];

/** The 12 month-ends the snapshots cover, oldest first, ending at the last month-end before the build. */
export function snapshotMonths(asOf = AS_OF, count = 12) {
  const d = new Date(`${asOf}T00:00:00Z`);
  const out: string[] = [];
  for (let k = count; k >= 1; k--) out.push(new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() - k + 1, 0)).toISOString().slice(0, 10));
  return out;
}

const DAY = 86_400_000;
const t0 = (s: string) => Date.parse(`${s.slice(0, 10)}T00:00:00Z`);
const daysBetween = (a: string, b: string) => Math.round((t0(b) - t0(a)) / DAY);
const monthsBetween = (a: string, b: string) => (Number(b.slice(0, 4)) - Number(a.slice(0, 4))) * 12 + Number(b.slice(5, 7)) - Number(a.slice(5, 7));
const shiftMonths = (s: string, k: number) => {
  const d = new Date(`${s}T00:00:00Z`);
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + k + 1, 0)).toISOString().slice(0, 10);
};
const round2 = (n: number) => Math.round(n * 100) / 100;
const FEE_SUMMARIES = new Set(['Asked about a recent fee', 'Disputed a card transaction']);

interface Exit {
  id: number;
  branch: number;
  join: string;
  close: string;
  birth: string;
  reason: string;
}

/**
 * One row per member per month-end: [month_end, party_id, branch_id, tenure_months, age, products,
 * has_checking, has_loan, deposit_balance, balance_change_3m, direct_deposit, dd_stopped_90d,
 * days_since_login, fees_3m, contacts_3m, complaints_3m, cert_maturing_90d].
 */
export function generateSnapshots(t: GeneratedTenant, rm: { digital: unknown[][]; activity: unknown[][]; interactions: unknown[][] }) {
  const months = snapshotMonths();
  const first = shiftMonths(months[0]!, -3);
  const rows: unknown[][] = [];
  const depsBy = new Map<number, unknown[][]>();
  for (const d of t.deposits) (depsBy.get(d[1] as number) ?? depsBy.set(d[1] as number, []).get(d[1] as number)!).push(d);
  const loansBy = new Map<number, unknown[][]>();
  for (const l of t.loans) (loansBy.get(l[1] as number) ?? loansBy.set(l[1] as number, []).get(l[1] as number)!).push(l);
  const digitalBy = new Map(rm.digital.map((d) => [d[0] as number, d]));
  const prior = new Map(rm.activity.filter((a) => a[0] === 'deposit').map((a) => [a[1] as number, { before: a[2] as number, fee: a[3] as number }]));
  const contactsBy = new Map<number, { at: string; fee: boolean }[]>();
  for (const i of rm.interactions) (contactsBy.get(i[1] as number) ?? contactsBy.set(i[1] as number, []).get(i[1] as number)!).push({ at: String(i[2]).slice(0, 10), fee: FEE_SUMMARIES.has(String(i[5])) });
  const openAt = (open: unknown, close: unknown, m: string) => String(open).slice(0, 10) <= m && (!close || String(close).slice(0, 10) > m);

  // Members today, back through the year: products and certificates from the accounts' own dates.
  for (const p of t.parties) {
    if (p[8] !== 1) continue;
    const id = p[0] as number;
    const join = String(p[4]).slice(0, 10);
    const birth = String(p[3]).slice(0, 10);
    const deps = depsBy.get(id) ?? [];
    const loans = loansBy.get(id) ?? [];
    const dig = digitalBy.get(id);
    const digitalSince = dig ? ([dig[1], dig[2]].filter(Boolean).map(String).sort()[0] ?? null) : null;
    const ddStatus = dig ? String(dig[6]) : 'none';
    const ddChanged = dig?.[7] ? String(dig[7]).slice(0, 10) : null;
    const lastLogin = dig?.[8] ? String(dig[8]).slice(0, 10) : null;
    // Balances: today's, with the 30-day change spread back over the months, plus a little noise.
    const nowBal = deps.filter((d) => !d[5]).reduce((s, d) => s + (d[7] as number), 0);
    const before = deps.filter((d) => !d[5]).reduce((s, d) => s + (prior.get(d[0] as number)?.before ?? (d[7] as number)), 0);
    const monthly = before > 0 ? Math.max(-0.5, Math.min(0.5, (nowBal - before) / before)) : 0;
    const balanceAt = (m: string) => {
      const k = monthsBetween(m, months.at(-1)!);
      const open = deps.filter((d) => openAt(d[4], d[5], m));
      if (!open.length) return 0;
      const base = open.reduce((s, d) => s + (d[7] as number), 0);
      // The recent move happened in the last month; before that, balances wandered a little.
      const drift = k >= 1 ? 1 / (1 + monthly) : 1;
      return Math.max(0, base * drift * (1 + (unit(id, 300 + k) - 0.5) * 0.06));
    };
    const fee30 = deps.reduce((s, d) => s + (prior.get(d[0] as number)?.fee ?? 0), 0);
    for (const m of months) {
      if (join > m) continue;
      const k = monthsBetween(m, months.at(-1)!);
      const bal = balanceAt(m);
      const bal3 = balanceAt(shiftMonths(m, -3));
      const cats = new Set([...deps.filter((d) => openAt(d[4], d[5], m)).map((d) => d[3]), ...loans.filter((l) => openAt(l[6], l[7], m)).map((l) => l[4])]);
      const dd = ddStatus === 'active' ? (!ddChanged || ddChanged <= m ? 1 : 0) : ddStatus === 'stopped' ? (ddChanged && ddChanged > m ? 1 : 0) : 0;
      const stopped = ddStatus === 'stopped' && ddChanged && ddChanged <= m && daysBetween(ddChanged, m) <= 90 ? 1 : 0;
      const login = !digitalSince || digitalSince > m ? 365 : lastLogin && lastLogin <= m ? Math.min(365, daysBetween(lastLogin, m)) : 1 + Math.floor(unit(id, 400 + k) * 20);
      const contacts = (contactsBy.get(id) ?? []).filter((c) => c.at <= m && daysBetween(c.at, m) < 92);
      const fees = k === 0 ? fee30 + (unit(id, 500) < 0.1 ? 29 : 0) : unit(id, 500 + k) < 0.08 ? 29 : unit(id, 520 + k) < 0.15 ? 5 : 0;
      const cert = deps.some((d) => d[6] && String(d[6]) > m && daysBetween(m, String(d[6])) <= 90) ? 1 : 0;
      let change = bal3 > 0 ? Math.max(-1, Math.min(9, Math.round(((bal - bal3) / bal3) * 1000) / 1000)) : 0;
      let shownBal = bal;
      let shownDd = dd;
      let shownStop = stopped;
      let shownLogin = login;
      // A false alarm: members who stay also have months that look like leaving (a paycheck moved, a
      // big purchase, a gap in logins) and then recover. Earlier in the year, never the latest month.
      const episode = unit(id, 600) < 0.12 ? Math.floor(unit(id, 601) * (months.length - 3)) : -1;
      const at = months.indexOf(m);
      if (episode >= 0 && at >= episode && at < episode + 2 + Math.floor(unit(id, 602) * 2) && at < months.length - 1) {
        change = -(0.15 + unit(id, 603 + at) * 0.35);
        shownBal = bal * (1 + change);
        if (dd && unit(id, 604) < 0.6) {
          shownDd = 0;
          shownStop = 1;
        }
        if (login < 365 && unit(id, 605) < 0.5) shownLogin = Math.min(364, login + 30 + Math.floor(unit(id, 606 + at) * 60));
      }
      rows.push([m, id, p[5], Math.max(0, monthsBetween(join, m)), Math.max(18, Math.min(100, Math.floor(daysBetween(birth, m) / 365.25))), cats.size, cats.has('Checking') ? 1 : 0, loans.some((l) => openAt(l[6], l[7], m)) ? 1 : 0, round2(shownBal), change, shownDd, shownStop, shownLogin, fees, Math.min(20, contacts.length), Math.min(10, contacts.filter((c) => c.fee).length), cert]);
    }
  }

  // Members who left: how they looked in the months before, with what usually comes before leaving.
  const byMember = new Map<number, unknown[][]>();
  for (const r of rows) (byMember.get(r[1] as number) ?? byMember.set(r[1] as number, []).get(r[1] as number)!).push(r);
  const memberIds = [...byMember.keys()];
  const exits: Exit[] = t.exits.map((x) => ({ id: x[0] as number, branch: x[1] as number, join: String(x[2]), close: String(x[3]), birth: String(x[4]), reason: String(x[6]) }));
  for (const x of exits) {
    if (x.close <= first) continue;
    const id = x.id;
    const u = (salt: number) => unit(id, salt);
    // How clearly this member showed it, and how many months ahead.
    const clarity: Record<string, number> = { 'Moved to a bank or fintech': 0.85, 'Rates or fees': 0.8, 'Service experience': 0.75, 'Inactive, closed by the credit union': 0.9, 'Moved away': 0.55, Deceased: 0.15 };
    const shows = u(1) < (clarity[x.reason] ?? 0.35);
    const lead = 1 + Math.floor(u(2) * 3);
    // Before the signs show, a leaver looks like an ordinary member: the months of a member who stayed,
    // picked by id, with the leaver's own branch. Only what comes before leaving differs.
    const template = byMember.get(memberIds[Math.floor(u(9) * memberIds.length)]!)!;
    for (const m of months) {
      if (x.join > m || x.close <= m) continue;
      const base = template.find((r) => r[0] === m) ?? template[0]!;
      const toGo = monthsBetween(m, x.close.slice(0, 7) + '-28');
      const near = shows && toGo <= lead;
      let prods = base[5] as number;
      let bal = base[8] as number;
      let change = base[9] as number;
      let dd = base[10] as number;
      let stopped = base[11] as number;
      let login = base[12] as number;
      let fees = base[13] as number;
      let contacts = base[14] as number;
      let complaints = base[15] as number;
      let cert = base[16] as number;
      const hadDd = dd === 1;
      const digital = login < 365;
      if (near) {
        const r = x.reason;
        const step = lead - toGo + 1;
        if (r === 'Moved to a bank or fintech') {
          dd = 0;
          stopped = hadDd || u(200) < 0.5 ? 1 : 0;
          change = -(1 - Math.pow(0.5, step)) - u(205) * 0.1;
          bal *= 1 + change;
          login = digital ? 30 + Math.floor(u(210 + toGo) * 60) : 365;
        } else if (r === 'Rates or fees') {
          fees = 29 * (1 + Math.floor(u(220 + toGo) * 3));
          complaints = 1 + Math.floor(u(230 + toGo) * 2);
          cert = u(240) < 0.5 ? 1 : cert;
          change = -0.2 - u(245) * 0.2;
          bal *= 1 + change;
        } else if (r === 'Service experience') {
          complaints = 1 + Math.floor(u(250 + toGo) * 3);
          contacts += 2 + Math.floor(u(260 + toGo) * 3);
          change = -0.1 - u(265) * 0.15;
          bal *= 1 + change;
        } else if (r === 'Inactive, closed by the credit union') {
          login = 365;
          dd = 0;
          prods = 1;
          bal = Math.min(bal, 150 + u(270) * 200);
          change = -0.02;
          contacts = 0;
        } else if (r === 'Moved away') {
          contacts += 1;
          dd = u(280) < 0.5 ? 0 : dd;
          stopped = hadDd && dd === 0 ? 1 : stopped;
          change = -0.3 - u(285) * 0.2;
          bal *= 1 + change;
        } else {
          change = -0.15 - u(295) * 0.15;
          bal *= 1 + change;
          login = digital ? 20 + Math.floor(u(290 + toGo) * 40) : 365;
        }
      }
      const age = base[4] as number;
      rows.push([m, id, x.branch, base[3], x.reason === 'Deceased' ? Math.max(age, 72 + Math.floor(u(300) * 20)) : age, prods, base[6], base[7], round2(Math.max(0, bal)), Math.round(change * 1000) / 1000, dd, stopped, login, fees, Math.min(20, contacts), Math.min(10, complaints), cert]);
    }
  }
  return rows;
}

export const SNAPSHOT_COLUMNS = ['month_end', 'party_id', 'branch_id', 'tenure_months', 'age', 'products', 'has_checking', 'has_loan', 'deposit_balance', 'balance_change_3m', 'direct_deposit', 'dd_stopped_90d', 'days_since_login', 'fees_3m', 'contacts_3m', 'complaints_3m', 'cert_maturing_90d'];
