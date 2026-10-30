// The structured semantic query request (spec 16.8 "Plan"). Agents build this; they never write SQL.
import { z } from 'zod';

const name = z.string().regex(/^[a-z][a-z0-9_]*$/);

export const SemanticQueryRequest = z
  .object({
    metrics: z.array(name).min(1).max(4).describe('Metric names from semantic_search, e.g. ["loan_balance"].'),
    dimensions: z.array(name).max(2).default([]).describe('Dimensions to group by, e.g. ["branch"]. Time is set with "time", not here.'),
    filters: z
      .array(
        z
          .object({
            dimension: name,
            op: z.enum(['in', 'not_in']),
            values: z.array(z.string().min(1).max(80)).min(1).max(20),
          })
          .strict(),
      )
      .max(4)
      .default([]),
    time: z
      .object({
        grain: z.enum(['month', 'quarter', 'year']),
        last: z.number().int().min(1).max(18).optional().describe('The most recent N complete periods.'),
        from: z.string().regex(/^\d{4}-\d{2}$/).optional().describe('First month, YYYY-MM.'),
        to: z.string().regex(/^\d{4}-\d{2}$/).optional().describe('Last month, YYYY-MM.'),
      })
      .strict()
      .optional()
      .describe('Omit for values as of the last nightly build. Set for trends and period comparisons from month-end history.'),
    order: z
      .array(z.object({ field: z.string(), dir: z.enum(['asc', 'desc']) }).strict())
      .max(2)
      .default([]),
    limit: z.number().int().min(1).max(500).default(100),
  })
  .strict();

export type SemanticQueryRequest = z.infer<typeof SemanticQueryRequest>;
export type SemanticQueryInput = z.input<typeof SemanticQueryRequest>;

/** Who is asking. Purview is applied by the service, never sent to a model (spec 25.5). */
export interface QueryContext {
  /** Branch names the user may see; undefined means the whole institution. */
  purviewBranches?: string[];
  /** Query Browser or Show Queries permission: compiled SQL is returned (BE-SEM-020). */
  canViewSql: boolean;
}

export type SemanticErrorCode =
  | 'UNKNOWN_METRIC'
  | 'UNKNOWN_DIMENSION'
  | 'DIMENSION_NOT_ALLOWED'
  | 'UNKNOWN_FILTER_VALUE'
  | 'CURRENT_ONLY'
  | 'NO_SOURCE'
  | 'INVALID_TIME'
  | 'NO_ACCESS';

export class SemanticError extends Error {
  constructor(
    readonly code: SemanticErrorCode,
    message: string,
    readonly suggestions: string[] = [],
  ) {
    super(message);
  }
}
