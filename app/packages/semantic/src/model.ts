// Loads and validates the semantic model (BE-SEM-002), applies tenant overrides (BE-SEM-003) and
// resolves labels for the institution type. A published model is identified as
// <stock version>+t<tenant revision> and every result records it (spec 16.3).
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse } from 'yaml';
import { z } from 'zod';

const ident = z.string().regex(/^[a-z][a-z0-9_]*$/);
/** SQL fragments live only in reviewed model files; they never come from users or models. */
const sqlFragment = z.string().min(1).max(500);
const labelsByType = z.object({ credit_union: z.string().optional(), bank: z.string().optional() }).optional();

const StockSchema = z.object({
  version: z.string().regex(/^\d+\.\d+\.\d+$/),
  settings: z.record(ident, z.object({ type: z.literal('integer'), default: z.number().int(), description: z.string() })),
  sources: z.record(
    ident,
    z.object({
      kind: z.enum(['current', 'history']),
      table: ident,
      alias: ident,
      joins: z.array(sqlFragment).default([]),
      filters: z.array(sqlFragment).default([]),
      time_column: sqlFragment.optional(),
      purview_column: sqlFragment,
      lineage: z.array(ident),
    }),
  ),
  dimensions: z.record(
    ident,
    z.object({
      label: z.string(),
      labels_by_type: labelsByType,
      description: z.string(),
      synonyms: z.array(z.string()).default([]),
      hierarchy: z.string().optional(),
      exprs: z.record(ident, sqlFragment),
      values_sql: sqlFragment.optional(),
      values: z.array(z.string()).optional(),
    }),
  ),
  measures: z.record(ident, z.object({ unit: z.enum(['usd', 'count', 'number']), flow: z.boolean().default(false), exprs: z.record(ident, sqlFragment) })),
  metrics: z.record(
    ident,
    z.object({
      label: z.string(),
      labels_by_type: labelsByType,
      type: z.enum(['simple', 'ratio']),
      measure: ident.optional(),
      numerator: ident.optional(),
      denominator: ident.optional(),
      format: z.enum(['currency', 'count', 'percent_1', 'percent_2', 'rate']),
      description: z.string(),
      regulatory_basis: z.string().optional(),
      synonyms: z.array(z.string()).default([]),
      owner: z.string(),
      dimensions_allowed: z.array(ident),
      current_only: z.boolean().default(false),
    }),
  ),
});

const OverrideSchema = z.object({
  tenant: z.string(),
  stock_version: z.string(),
  revision: z.number().int().positive(),
  synonyms: z.record(ident, z.array(z.string())).default({}),
  labels: z.record(ident, z.string()).default({}),
  settings: z.record(ident, z.number().int()).default({}),
});

type Stock = z.infer<typeof StockSchema>;
export type InstitutionType = 'credit_union' | 'bank';
export type MetricFormat = Stock['metrics'][string]['format'];

export interface Metric {
  name: string;
  label: string;
  type: 'simple' | 'ratio';
  measures: string[];
  format: MetricFormat;
  description: string;
  regulatoryBasis?: string;
  synonyms: string[];
  owner: string;
  dimensionsAllowed: string[];
  currentOnly: boolean;
}

export interface Dimension {
  name: string;
  label: string;
  description: string;
  synonyms: string[];
  exprs: Record<string, string>;
  valuesSql?: string;
  values?: string[];
}

export interface Measure {
  name: string;
  unit: 'usd' | 'count' | 'number';
  flow: boolean;
  exprs: Record<string, string>;
}

export type Source = Stock['sources'][string] & { name: string };

export interface SemanticModel {
  /** e.g. "1.0.0+t3" */
  version: string;
  tenant: string;
  institutionType: InstitutionType;
  settings: Record<string, number>;
  sources: Record<string, Source>;
  dimensions: Record<string, Dimension>;
  measures: Record<string, Measure>;
  metrics: Record<string, Metric>;
}

const MODELS_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'models');

export function loadModel(tenant: string, institutionType: InstitutionType, dir = MODELS_DIR): SemanticModel {
  const stock = StockSchema.parse(parse(readFileSync(join(dir, 'stock', 'model.yaml'), 'utf8')));
  const override = OverrideSchema.parse(parse(readFileSync(join(dir, 'tenants', `${tenant}.yaml`), 'utf8')));
  if (override.stock_version !== stock.version) {
    throw new Error(`Tenant ${tenant} pins stock ${override.stock_version} but ${stock.version} is loaded`);
  }
  const label = (name: string, base: string, byType?: { credit_union?: string; bank?: string }) => override.labels[name] ?? byType?.[institutionType] ?? base;

  const settings = Object.fromEntries(Object.entries(stock.settings).map(([k, v]) => [k, override.settings[k] ?? v.default]));
  const sources = Object.fromEntries(Object.entries(stock.sources).map(([name, s]) => [name, { ...s, name }]));
  const measures = Object.fromEntries(Object.entries(stock.measures).map(([name, m]) => [name, { name, ...m }]));
  const dimensions = Object.fromEntries(
    Object.entries(stock.dimensions).map(([name, d]) => [
      name,
      { name, label: label(name, d.label, d.labels_by_type), description: d.description, synonyms: [...d.synonyms, ...(override.synonyms[name] ?? [])], exprs: d.exprs, valuesSql: d.values_sql, values: d.values },
    ]),
  );
  const metrics = Object.fromEntries(
    Object.entries(stock.metrics).map(([name, m]) => {
      const ms = m.type === 'simple' ? [m.measure!] : [m.numerator!, m.denominator!];
      for (const x of ms) if (!measures[x]) throw new Error(`Metric ${name} uses unknown measure ${x}`);
      for (const d of m.dimensions_allowed) if (!dimensions[d]) throw new Error(`Metric ${name} allows unknown dimension ${d}`);
      return [
        name,
        {
          name,
          label: label(name, m.label, m.labels_by_type),
          type: m.type,
          measures: ms,
          format: m.format,
          description: m.description,
          regulatoryBasis: m.regulatory_basis,
          synonyms: [...m.synonyms, ...(override.synonyms[name] ?? [])],
          owner: m.owner,
          dimensionsAllowed: m.dimensions_allowed,
          currentOnly: m.current_only,
        } satisfies Metric,
      ];
    }),
  );
  return { version: `${stock.version}+t${override.revision}`, tenant, institutionType, settings, sources, dimensions, measures, metrics };
}
