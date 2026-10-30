// Semantic query compiler (spec 16.8 Validate, Compile, Secure). Produces identical SQL for
// identical requests and model versions (BE-SEM-021); every value is a bind parameter (BE-SEM-022).
import type { Metric, SemanticModel, Source } from './model.ts';
import { SemanticError, type QueryContext, type SemanticQueryRequest } from './request.ts';

export interface Period {
  key: string;
  label: string;
  /** Inclusive month-end bounds of the period. */
  start: string;
  end: string;
}

export interface CompiledPart {
  source: string;
  /** Point-in-time measures take the period-end value; flow measures sum over the period. */
  timeMode: 'current' | 'pit' | 'flow';
  sql: string;
  params: (string | number)[];
  measures: string[];
  dimensions: string[];
}

export interface CompiledQuery {
  request: SemanticQueryRequest;
  metrics: Metric[];
  periods: Period[] | null;
  parts: CompiledPart[];
  /** Plain-English filters for the answer's "filters applied" line (spec 6.12). */
  filtersApplied: string[];
  lineage: { metric: string; measures: string[]; tables: string[] }[];
}

export interface CompileEnv {
  model: SemanticModel;
  /** Canonical values per dimension, for matching free-text filter values. */
  dimensionValues: Record<string, string[]>;
  /** Branch name to id, for purview predicates. */
  branchIds: Record<string, number>;
  /** Latest complete month-end in history (the month before the build's as-of date). */
  latestMonthEnd: string;
}

const pad = (n: number) => String(n).padStart(2, '0');
const monthEnd = (y: number, m: number) => {
  const d = new Date(Date.UTC(y, m, 0));
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
};
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** Complete periods ending at the latest month-end, oldest first. */
export function resolvePeriods(time: NonNullable<SemanticQueryRequest['time']>, latestMonthEnd: string): Period[] {
  const [ly, lm] = latestMonthEnd.split('-').map(Number) as [number, number];
  const months: { y: number; m: number }[] = [];
  const from = time.from ? (time.from.split('-').map(Number) as [number, number]) : null;
  const to: [number, number] = time.to ? (time.to.split('-').map(Number) as [number, number]) : [ly, lm];
  if (to[0] * 12 + to[1] > ly * 12 + lm) throw new SemanticError('INVALID_TIME', `History runs to ${latestMonthEnd}; ${time.to} has no complete month-end yet.`);
  for (let i = 0; i < 18; i++) {
    const idx = to[0] * 12 + (to[1] - 1) - i;
    const y = Math.floor(idx / 12);
    const m = (idx % 12) + 1;
    if (from && y * 12 + m < from[0] * 12 + from[1]) break;
    months.unshift({ y, m });
  }
  const bucket = (y: number, m: number) =>
    time.grain === 'month'
      ? { key: `${y}-${pad(m)}`, label: `${MONTHS[m - 1]} ${y}` }
      : time.grain === 'quarter'
        ? { key: `${y}-Q${Math.ceil(m / 3)}`, label: `Q${Math.ceil(m / 3)} ${y}` }
        : { key: `${y}`, label: `${y}` };
  const byKey = new Map<string, Period>();
  for (const { y, m } of months) {
    const b = bucket(y, m);
    const end = monthEnd(y, m);
    const p = byKey.get(b.key);
    if (p) p.end = end;
    else byKey.set(b.key, { ...b, start: monthEnd(y, m), end });
  }
  let periods = [...byKey.values()];
  // A quarter or year counts only when all of its months are in history, so sums are never partial.
  if (time.grain !== 'month') {
    periods = periods.filter((p) => {
      const startMonth = Number(p.start.slice(5, 7));
      const endMonth = Number(p.end.slice(5, 7));
      return time.grain === 'quarter' ? endMonth % 3 === 0 && startMonth === endMonth - 2 : startMonth === 1 && endMonth === 12;
    });
  }
  if (time.last) periods = periods.slice(-time.last);
  if (!periods.length) throw new SemanticError('INVALID_TIME', 'No complete period falls in that range.', ['Try a monthly grain or a longer range.']);
  return periods;
}

function closest(value: string, options: string[]): string[] {
  const v = value.toLowerCase();
  return options.filter((o) => o.toLowerCase().includes(v) || v.includes(o.toLowerCase())).slice(0, 3);
}

function setting(sql: string, model: SemanticModel) {
  return sql.replace(/\{\{\s*setting\.([a-z_]+)\s*\}\}/g, (_, k: string) => {
    const v = model.settings[k];
    if (v === undefined || !Number.isInteger(v)) throw new Error(`Unknown setting ${k}`);
    return String(v);
  });
}

export function compile(request: SemanticQueryRequest, ctx: QueryContext, env: CompileEnv): CompiledQuery {
  const { model } = env;
  const metrics = request.metrics.map((m) => {
    const metric = model.metrics[m];
    if (!metric) {
      throw new SemanticError('UNKNOWN_METRIC', `There is no metric called "${m}".`, Object.keys(model.metrics).filter((k) => k.includes(m.split('_')[0] ?? m)).slice(0, 3));
    }
    return metric;
  });
  for (const d of request.dimensions) {
    if (!model.dimensions[d]) throw new SemanticError('UNKNOWN_DIMENSION', `There is no dimension called "${d}".`, Object.keys(model.dimensions));
    for (const m of metrics) {
      if (!m.dimensionsAllowed.includes(d)) {
        throw new SemanticError(
          'DIMENSION_NOT_ALLOWED',
          m.dimensionsAllowed.length ? `${m.label} cannot be broken down by ${model.dimensions[d]!.label.toLowerCase()}.` : `${m.label} is institution-level only.`,
          m.dimensionsAllowed.map((x) => model.dimensions[x]!.label),
        );
      }
    }
  }

  // Canonicalise filter values against each dimension's value list (BE-SEM-022).
  const filters = request.filters.map((f) => {
    const dim = model.dimensions[f.dimension];
    if (!dim) throw new SemanticError('UNKNOWN_DIMENSION', `There is no dimension called "${f.dimension}".`, Object.keys(model.dimensions));
    for (const m of metrics) if (!m.dimensionsAllowed.includes(f.dimension)) throw new SemanticError('DIMENSION_NOT_ALLOWED', `${m.label} cannot be filtered by ${dim.label.toLowerCase()}.`);
    const options = env.dimensionValues[f.dimension] ?? [];
    const values = f.values.map((v) => {
      const hit = options.find((o) => o.toLowerCase() === v.trim().toLowerCase());
      if (!hit) throw new SemanticError('UNKNOWN_FILTER_VALUE', `"${v}" is not a ${dim.label.toLowerCase()}.`, closest(v, options).length ? closest(v, options) : options.slice(0, 8));
      return hit;
    });
    return { ...f, values };
  });

  // Purview: the branches a user may see, applied to every part (spec 20.7, 25.5).
  let purviewIds: number[] | null = null;
  if (ctx.purviewBranches) {
    purviewIds = ctx.purviewBranches.map((b) => env.branchIds[b]).filter((x): x is number => x !== undefined).sort((a, b) => a - b);
    if (!purviewIds.length) throw new SemanticError('NO_ACCESS', 'Your purview does not include any branch with data.');
    // Naming a branch outside the purview is refused outright, without saying whether data exists.
    const outside = filters.filter((f) => f.dimension === 'branch' && f.op === 'in').flatMap((f) => f.values.filter((v) => !ctx.purviewBranches!.includes(v)));
    if (outside.length) throw new SemanticError('NO_ACCESS', `${outside.join(', ')} ${outside.length === 1 ? 'is' : 'are'} outside your Report Viewer purview.`);
  }

  const periods = request.time ? resolvePeriods(request.time, env.latestMonthEnd) : null;
  const kind = periods ? 'history' : 'current';
  for (const m of metrics) if (periods && m.currentOnly) throw new SemanticError('CURRENT_ONLY', `${m.label} is available as of the last nightly build only, not as a trend.`);

  // Group the needed measures by source and time mode, in a stable order.
  const groups = new Map<string, { source: Source; timeMode: CompiledPart['timeMode']; measures: string[] }>();
  const lineage: CompiledQuery['lineage'] = [];
  for (const m of metrics) {
    const tables = new Set<string>();
    for (const measureName of m.measures) {
      const measure = model.measures[measureName]!;
      const source = Object.values(model.sources).find((s) => s.kind === kind && measure.exprs[s.name] && request.dimensions.every((d) => model.dimensions[d]!.exprs[s.name]) && filters.every((f) => model.dimensions[f.dimension]!.exprs[s.name]));
      if (!source) {
        throw new SemanticError('NO_SOURCE', periods ? `${m.label} has no month-end history, so it cannot be trended.` : `${m.label} is reported for complete months only. Ask for a period, such as the last month.`, periods ? [] : ['last complete month']);
      }
      source.lineage.forEach((t) => tables.add(t));
      const timeMode = !periods ? 'current' : measure.flow ? 'flow' : 'pit';
      const key = `${source.name}|${timeMode}`;
      const g = groups.get(key) ?? { source, timeMode, measures: [] };
      if (!g.measures.includes(measureName)) g.measures.push(measureName);
      groups.set(key, g);
    }
    lineage.push({ metric: m.name, measures: m.measures, tables: [...tables].sort() });
  }

  const parts: CompiledPart[] = [...groups.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([, g]) => compilePart(g.source, g.timeMode, g.measures, request.dimensions, filters, purviewIds, periods, request.time?.grain, env));

  const filtersApplied = [
    ...filters.map((f) => `${model.dimensions[f.dimension]!.label} ${f.op === 'in' ? 'is' : 'is not'} ${f.values.join(', ')}`),
    ...(periods ? [`Period: ${periods[0]!.label}${periods.length > 1 ? ` to ${periods[periods.length - 1]!.label}` : ''}`] : []),
    ...(ctx.purviewBranches ? [`Limited to your purview: ${ctx.purviewBranches.join(', ')}`] : []),
  ];
  return { request, metrics, periods, parts, filtersApplied, lineage };
}

function compilePart(
  source: Source,
  timeMode: CompiledPart['timeMode'],
  measures: string[],
  dimensions: string[],
  filters: { dimension: string; op: 'in' | 'not_in'; values: string[] }[],
  purviewIds: number[] | null,
  periods: Period[] | null,
  grain: 'month' | 'quarter' | 'year' | undefined,
  env: CompileEnv,
): CompiledPart {
  const { model } = env;
  const params: (string | number)[] = [];
  const select: string[] = [];
  const groupBy: string[] = [];
  dimensions.forEach((d, i) => {
    const expr = model.dimensions[d]!.exprs[source.name]!;
    select.push(`${expr} AS d${i}`);
    groupBy.push(`d${i}`);
  });

  const where = [...source.filters];
  if (purviewIds) {
    where.push(`${source.purview_column} IN (${purviewIds.map(() => '?').join(', ')})`);
    params.push(...purviewIds);
  }
  for (const f of filters) {
    where.push(`${model.dimensions[f.dimension]!.exprs[source.name]} ${f.op === 'in' ? 'IN' : 'NOT IN'} (${f.values.map(() => '?').join(', ')})`);
    params.push(...f.values);
  }

  if (periods && source.time_column) {
    const t = source.time_column;
    // The period key; quarters and years bucket month-ends with plain date arithmetic.
    const periodExpr = grain === 'month' ? `DATE_FORMAT(${t}, '%Y-%m')` : grain === 'quarter' ? `CONCAT(YEAR(${t}), '-Q', QUARTER(${t}))` : `CAST(YEAR(${t}) AS CHAR)`;
    select.push(`${periodExpr} AS period`);
    groupBy.push('period');
    if (timeMode === 'pit') {
      // Point-in-time measures read the last month-end of each period.
      where.push(`${t} IN (${periods.map(() => '?').join(', ')})`);
      params.push(...periods.map((p) => p.end));
    } else {
      where.push(`${t} BETWEEN ? AND ?`);
      params.push(periods[0]!.start, periods[periods.length - 1]!.end);
    }
  }

  for (const m of measures) select.push(`${setting(model.measures[m]!.exprs[source.name]!, model)} AS m_${m}`);

  const sql = [
    `SELECT ${select.join(', ')}`,
    `FROM ${source.table} AS ${source.alias}`,
    ...source.joins,
    where.length ? `WHERE ${where.join(' AND ')}` : '',
    groupBy.length ? `GROUP BY ${groupBy.join(', ')}` : '',
    groupBy.length ? `ORDER BY ${groupBy.join(', ')}` : '',
  ]
    .filter(Boolean)
    .join('\n');
  return { source: source.name, timeMode, sql, params, measures, dimensions };
}
