// Data quality checks from the ontology (Core Mapping and Ontology, phase 6): every constraint and
// fixed code list on a property becomes a check on each DI column that holds it, run against this
// institution's current tables and recorded beside the other checks in ops_dq_check, where the data
// quality page, Operations and lineage already read them.
import { ontology, ontologyChecks, type OntologyCheck } from '@dinext/ontology';
import { MODULE_FIXTURES, type Pool } from '@dinext/tenant-db';
import { LINEAGE_CATALOG } from './governance.ts';

type InstitutionType = 'credit_union' | 'bank';
const rows = async <T>(pool: Pool, sql: string, params: unknown[] = []) => (await pool.query(sql, params))[0] as T[];

export interface OntologyCheckResult {
  rule: string;
  name: string;
  domain: string;
  dimension: string;
  table: string;
  column: string;
  property: string;
  rowsFailed: number;
}

/** The engineer's rule behind each ontology check's name, for the checks list: the table holds the name only. */
const RULES = new Map<string, string>();
export const ontologyRule = (name: string) => RULES.get(name) ?? null;

/**
 * Seeded checks a real one replaces: their results were written by hand, so once the ontology's check
 * has run on the data, the hand-written row would only contradict it.
 */
const SUPERSEDES: Record<string, string> = {
  'cdm_deposit_account.open_date not after the as-of date': 'share.open_date not in future',
  'cdm_loan.days_delinquent at least 0': 'delinquency days are not negative',
};

/** Names fit the table's 80 characters; a property held in two tables names the table it checks. */
function named(checks: OntologyCheck[]) {
  const count = new Map<string, number>();
  for (const c of checks) count.set(c.name, (count.get(c.name) ?? 0) + 1);
  return checks.map((c) => {
    const where = LINEAGE_CATALOG[c.table]?.label.toLowerCase() ?? c.table.replace(/^cdm_/, '').replace(/_/g, ' ');
    const name = (count.get(c.name) ?? 0) > 1 ? `${c.name}, in ${where}` : c.name;
    return { ...c, name: name.length <= 80 ? name : c.rule };
  });
}

/**
 * Runs the ontology's checks on the current cdm_* tables and the month-end hist_* rollups (phase 8),
 * and replaces their earlier results. Read-only on the data; writes only its own rows in ops_dq_check.
 * Returns each result.
 */
export async function runOntologyChecks(pool: Pool, type: InstitutionType): Promise<OntologyCheckResult[]> {
  const tables = new Set((await rows<{ t: string }>(pool, "SELECT table_name AS t FROM information_schema.tables WHERE table_schema = DATABASE() AND (table_name LIKE 'cdm\\_%' OR table_name LIKE 'hist\\_%')")).map((r) => r.t.toLowerCase()));
  const [build] = await rows<{ as_of_date: unknown }>(pool, 'SELECT as_of_date FROM meta_build ORDER BY as_of_date DESC LIMIT 1').catch(() => []);
  const asOf = build ? (build.as_of_date instanceof Date ? build.as_of_date.toISOString() : String(build.as_of_date)).slice(0, 10) : new Date().toISOString().slice(0, 10);
  const checks = named(ontologyChecks(ontology(), tables, type));
  const results: OntologyCheckResult[] = [];
  for (const c of checks) {
    const params = c.params.map((p) => (p === '$asOf' ? asOf : p));
    const [r] = await rows<{ n: number }>(pool, `SELECT COUNT(*) AS n FROM \`${c.table}\` WHERE ${c.failsWhen}`, params).catch(() => [{ n: -1 }]);
    // A check that can't run (a column this tenant's table lacks) is left out, not recorded as passing.
    if (Number(r?.n) < 0) continue;
    results.push({ rule: c.rule, name: c.name, domain: LINEAGE_CATALOG[c.table]?.domains.at(-1) ?? 'Core Integration', dimension: c.dimension, table: c.table, column: c.column, property: c.property, rowsFailed: Number(r!.n) });
  }
  for (const r of results) RULES.set(r.name, r.rule);
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    // Every row but the seeded checks is this runner's, under whatever name an earlier version gave it;
    // a seeded check a real one now covers goes too.
    const replaced = new Set(results.map((r) => SUPERSEDES[r.rule]).filter((x): x is string => !!x));
    const keep = MODULE_FIXTURES.checks.map((c) => String(c[2])).filter((rule) => !replaced.has(rule));
    await conn.query(`DELETE FROM ops_dq_check WHERE name NOT IN (${keep.map(() => '?').join(', ')})`, keep);
    if (results.length) await conn.query('INSERT INTO ops_dq_check (domain, dimension, name, status, rows_failed) VALUES ?', [results.map((r) => [r.domain, r.dimension, r.name, r.rowsFailed ? 'Fail' : 'Pass', r.rowsFailed])]);
    await conn.commit();
  } catch (e) {
    await conn.rollback();
    throw e;
  } finally {
    conn.release();
  }
  return results;
}
