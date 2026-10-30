// Semantic Layer service (spec 13.3 service 7, 16.8 Execute and return). Runs compiled parts
// through the read-only tenant pool with a statement timeout and row cap, merges them, and returns
// rows plus the model version, build, lineage, plain-English explanation and SQL hash.
import { createHash } from 'node:crypto';
import type { Pool } from 'mysql2/promise';
import { searchCatalog, type CatalogResult } from './catalog.ts';
import { compile, type CompileEnv, type Period } from './compile.ts';
import { loadModel, type InstitutionType, type Metric, type MetricFormat, type SemanticModel } from './model.ts';
import { SemanticError, SemanticQueryRequest, type QueryContext, type SemanticQueryInput } from './request.ts';

export interface BuildInfo {
  buildId: string;
  /** Business date the data describes. */
  asOf: string;
  /** When the nightly build finished (ISO, tenant local time). */
  completedAt: string;
  latestMonthEnd: string;
}

export interface ResultColumn {
  key: string;
  label: string;
  kind: 'dimension' | 'period' | 'metric';
  format?: MetricFormat;
}

export type ResultRow = Record<string, string | number | null>;

export interface SemanticResult {
  queryId: string;
  modelVersion: string;
  build: BuildInfo;
  request: SemanticQueryRequest;
  columns: ResultColumn[];
  rows: ResultRow[];
  rowCount: number;
  truncated: boolean;
  periods: Period[] | null;
  filtersApplied: string[];
  lineage: { metric: string; measures: string[]; tables: string[] }[];
  explanation: string;
  /** Present only for users with Query Browser or Show Queries (BE-SEM-020). */
  sql?: string[];
  sqlHash: string;
  elapsedMs: number;
}

export interface MetricDefinition {
  name: string;
  label: string;
  description: string;
  formula: string;
  regulatoryBasis?: string;
  owner: string;
  version: string;
  dimensionsAllowed: string[];
  trendable: boolean;
}

const STATEMENT_TIMEOUT_MS = 30_000;
export const AGENT_ROW_CAP = 10_000;

export class SemanticService {
  private constructor(
    readonly model: SemanticModel,
    private readonly pool: Pool,
    readonly build: BuildInfo,
    readonly dimensionValues: Record<string, string[]>,
    private readonly branchIds: Record<string, number>,
  ) {}

  static async create(pool: Pool, tenant: string, institutionType: InstitutionType): Promise<SemanticService> {
    const model = loadModel(tenant, institutionType);
    const [builds] = (await pool.query("SELECT build_id, as_of_date, completed_at FROM meta_build WHERE state = 'completed' ORDER BY completed_at DESC LIMIT 1")) as unknown as [{ build_id: string; as_of_date: string; completed_at: string }[]];
    const b = builds[0];
    if (!b) throw new Error(`Tenant ${tenant} has no completed build`);
    const asOf = b.as_of_date.slice(0, 10);
    const d = new Date(`${asOf}T00:00:00Z`);
    const latestMonthEnd = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 0)).toISOString().slice(0, 10);
    const dimensionValues: Record<string, string[]> = {};
    for (const dim of Object.values(model.dimensions)) {
      if (dim.values) dimensionValues[dim.name] = dim.values;
      else if (dim.valuesSql) {
        const [rows] = (await pool.query(dim.valuesSql)) as unknown as [Record<string, string>[]];
        dimensionValues[dim.name] = rows.map((r) => String(Object.values(r)[0]));
      }
    }
    const [locs] = (await pool.query('SELECT int_id, name FROM cdm_location')) as unknown as [{ int_id: number; name: string }[]];
    return new SemanticService(model, pool, { buildId: b.build_id, asOf, completedAt: b.completed_at.replace(' ', 'T'), latestMonthEnd }, dimensionValues, Object.fromEntries(locs.map((l) => [l.name, l.int_id])));
  }

  private get env(): CompileEnv {
    return { model: this.model, dimensionValues: this.dimensionValues, branchIds: this.branchIds, latestMonthEnd: this.build.latestMonthEnd };
  }

  search(query: string): CatalogResult {
    return searchCatalog(this.model, query, this.dimensionValues);
  }

  definition(name: string): MetricDefinition {
    const m = this.model.metrics[name];
    if (!m) throw new SemanticError('UNKNOWN_METRIC', `There is no metric called "${name}".`, Object.keys(this.model.metrics));
    return {
      name: m.name,
      label: m.label,
      description: m.description,
      formula: formulaOf(m),
      regulatoryBasis: m.regulatoryBasis,
      owner: m.owner,
      version: this.model.version,
      dimensionsAllowed: m.dimensionsAllowed.map((d) => this.model.dimensions[d]!.label),
      trendable: !m.currentOnly,
    };
  }

  /** Validates, compiles, secures and runs a semantic query (spec 16.8). Throws SemanticError. */
  async query(input: SemanticQueryInput, ctx: QueryContext): Promise<SemanticResult> {
    const started = Date.now();
    const parsed = SemanticQueryRequest.safeParse(input);
    if (!parsed.success) throw new SemanticError('UNKNOWN_METRIC', `The query request is not valid: ${parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ')}`);
    const request = parsed.data;
    const compiled = compile(request, ctx, this.env);

    // Run each part and merge by dimension values and period.
    const merged = new Map<string, ResultRow>();
    for (const part of compiled.parts) {
      const [rows] = (await this.pool.query({ sql: part.sql, timeout: STATEMENT_TIMEOUT_MS }, part.params)) as unknown as [Record<string, unknown>[]];
      for (const r of rows.slice(0, AGENT_ROW_CAP)) {
        const dims = request.dimensions.map((_, i) => String(r[`d${i}`] ?? ''));
        const key = [...dims, String(r.period ?? '')].join('\u0000');
        const row = merged.get(key) ?? Object.fromEntries([...request.dimensions.map((d, i) => [d, dims[i]!]), ...(compiled.periods ? [['period', String(r.period)]] : [])]);
        for (const m of part.measures) row[`__${m}`] = r[`m_${m}`] === null ? null : Number(r[`m_${m}`]);
        merged.set(key, row);
      }
    }

    const periodLabel = new Map((compiled.periods ?? []).map((p) => [p.key, p.label]));
    let rows = [...merged.values()].map((row) => {
      const out: ResultRow = {};
      for (const d of request.dimensions) out[d] = row[d] ?? null;
      if (compiled.periods) out.period = periodLabel.get(String(row.period)) ?? String(row.period);
      for (const m of compiled.metrics) out[m.name] = metricValue(m, row);
      return out;
    });

    // Order: requested fields, then dimensions and period for a stable result (BE-SEM-021).
    const periodIndex = new Map((compiled.periods ?? []).map((p, i) => [p.label, i]));
    const order = request.order.filter((o) => o.field === 'period' || request.dimensions.includes(o.field) || request.metrics.includes(o.field));
    rows.sort((a, b) => {
      for (const o of order) {
        const c = compareValues(a[o.field] ?? null, b[o.field] ?? null) * (o.dir === 'desc' ? -1 : 1);
        if (c) return c;
      }
      for (const d of request.dimensions) {
        const c = compareValues(a[d] ?? null, b[d] ?? null);
        if (c) return c;
      }
      return (periodIndex.get(String(a.period)) ?? 0) - (periodIndex.get(String(b.period)) ?? 0);
    });
    const rowCount = rows.length;
    rows = rows.slice(0, request.limit);

    const columns: ResultColumn[] = [
      ...request.dimensions.map((d) => ({ key: d, label: this.model.dimensions[d]!.label, kind: 'dimension' as const })),
      ...(compiled.periods ? [{ key: 'period', label: 'Period', kind: 'period' as const }] : []),
      ...compiled.metrics.map((m) => ({ key: m.name, label: m.label, kind: 'metric' as const, format: m.format })),
    ];
    const sqlText = compiled.parts.map((p) => `${p.sql}\n-- params: ${JSON.stringify(p.params)}`);
    const sqlHash = `sha256:${createHash('sha256').update(sqlText.join('\n;\n')).digest('hex').slice(0, 16)}`;
    return {
      queryId: `sq_${createHash('sha256').update(`${this.model.version}|${this.build.buildId}|${JSON.stringify(request)}|${JSON.stringify(ctx.purviewBranches ?? null)}`).digest('hex').slice(0, 12)}`,
      modelVersion: this.model.version,
      build: this.build,
      request,
      columns,
      rows,
      rowCount,
      truncated: rowCount > rows.length,
      periods: compiled.periods,
      filtersApplied: compiled.filtersApplied,
      lineage: compiled.lineage,
      explanation: explain(compiled.metrics, request, compiled.periods, this.model, this.build),
      sql: ctx.canViewSql ? sqlText : undefined,
      sqlHash,
      elapsedMs: Date.now() - started,
    };
  }
}

function metricValue(m: Metric, row: ResultRow): number | null {
  if (m.type === 'simple') return (row[`__${m.measures[0]}`] as number | null | undefined) ?? 0;
  const num = row[`__${m.measures[0]}`] as number | null | undefined;
  const den = row[`__${m.measures[1]}`] as number | null | undefined;
  if (num === null || num === undefined || !den) return null;
  // Ratios are shown in percent; the rate ratio is already in percent points.
  return m.format === 'rate' ? num / den : (num / den) * 100;
}

function compareValues(a: string | number | null, b: string | number | null) {
  if (a === b) return 0;
  if (a === null) return 1;
  if (b === null) return -1;
  return typeof a === 'number' && typeof b === 'number' ? a - b : String(a).localeCompare(String(b));
}

function formulaOf(m: Metric) {
  const readable = (s: string) => s.replace(/_sum$|_count$/, '').replaceAll('_', ' ');
  return m.type === 'simple' ? `Sum of ${readable(m.measures[0]!)}` : `${readable(m.measures[0]!)} ÷ ${readable(m.measures[1]!)}`;
}

function explain(metrics: Metric[], request: SemanticQueryRequest, periods: Period[] | null, model: SemanticModel, build: BuildInfo) {
  const parts = metrics.map((m) => `${m.label}: ${m.description}`);
  const by = request.dimensions.length ? ` Broken down by ${request.dimensions.map((d) => model.dimensions[d]!.label.toLowerCase()).join(' and ')}.` : '';
  const when = periods
    ? ` Values are month-end figures from history for ${periods[0]!.label}${periods.length > 1 ? ` to ${periods[periods.length - 1]!.label}` : ''}.`
    : ` Values are as of the nightly build for ${build.asOf}.`;
  return `${parts.join(' ')}${by}${when}`;
}
