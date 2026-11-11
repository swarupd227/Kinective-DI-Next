// Sales Override Approvals (DI's Home card): incentive adjustments staff have entered that wait for a
// different person to review, across the branches the user can see. Deciding one stays with the Goals
// & Incentives agent ("Approve the adjustment for …"); this is the queue, and the Home day plan line.
import { z } from 'zod';
import { CoreError } from '@dinext/di-core';
import type { Pool } from '@dinext/tenant-db';
import { moduleTable, type ModuleContext, type ModuleSpec } from './moduleAgent.ts';

export const SALES_OVERRIDE_REQUEST = /\b(?:sales |incentive )?overrides?\b|\b(?:incentive )?adjustments? (?:(?:are|that are) )?(?:waiting|pending|to review|for (?:my )?review)\b|\bpending (?:incentive )?adjustments?\b/i;
const NO_ACCESS = 'Reviewing sales overrides isn’t part of your DI access.';
const usd = (n: number) => `${n < 0 ? '−' : ''}$${Math.abs(n).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

interface Pending {
  adjustmentId: number;
  name: string;
  branch: string;
  periodEnd: string;
  amount: number;
  reason: string;
  note: string;
  by: string;
}

async function pending(pool: Pool, ctx: ModuleContext): Promise<Pending[]> {
  const scope = ctx.purviewBranches ? ' AND b.name IN (?)' : '';
  const [rows] = await pool.query(
    `SELECT a.adjustment_id, e.display_name, b.name AS branch, a.period_end, a.amount, a.reason_code, a.note, a.created_by
       FROM mod_gi_adjustment a JOIN cdm_employee e ON e.employee_id = a.employee_id JOIN cdm_location b ON b.int_id = e.branch_id
      WHERE a.status = 'Pending' AND a.created_by <> ?${scope} ORDER BY a.period_end, a.adjustment_id`,
    [ctx.user.id, ...(ctx.purviewBranches ? [ctx.purviewBranches.length ? ctx.purviewBranches : ['']] : [])],
  );
  return (rows as Record<string, unknown>[]).map((r) => ({
    adjustmentId: r.adjustment_id as number,
    name: r.display_name as string,
    branch: r.branch as string,
    periodEnd: String(r.period_end instanceof Date ? r.period_end.toISOString() : r.period_end).slice(0, 10),
    amount: Number(r.amount),
    reason: r.reason_code as string,
    note: r.note as string,
    by: r.created_by as string,
  }));
}

export function salesOverridesModule(pool: Pool): ModuleSpec {
  const need = (ctx: ModuleContext) => {
    if (!ctx.modules.includes('overrides')) throw new CoreError('NO_ACCESS', NO_ACCESS);
  };
  const spec: ModuleSpec = {
    id: 'overrides',
    prefix: 'so',
    agent: 'Sales Overrides',
    request: SALES_OVERRIDE_REQUEST,
    noAccess: NO_ACCESS,
    sources: [{ kind: 'table', label: 'Incentive adjustments', ref: 'table:mod_gi_adjustment' }],
    prompt: ({ tenant, user, title }) => `You are the Sales Overrides agent inside Kinective Data Intelligence (DI) for ${tenant}. ${user} (${title}) reviews incentive adjustments (sales overrides) other people entered.

- so_pending: the adjustments waiting for review in the branches the user can see, oldest period first. The user can't review their own.
Approving or returning one is the Goals & Incentives agent's: suggest "Approve the adjustment for <name>" or "Return the adjustment for <name>".`,
    today: async (ctx) => {
      if (!ctx.modules.includes('overrides')) return null;
      const list = await pending(pool, ctx);
      if (!list.length) return null;
      return { id: 'overrides', title: `${list.length} sales ${list.length === 1 ? 'override' : 'overrides'} waiting for your review`, why: `Oldest: ${list[0]!.name}, ${usd(list[0]!.amount)} (${list[0]!.reason}).`, badge: 'Approval', ask: 'Show the sales overrides waiting for review', weight: 60 };
    },
    plan: () => ({ tool: 'so_pending', args: {} }),
    tools: [
      {
        name: 'so_pending',
        description: 'Incentive adjustments (sales overrides) waiting for review in the branches the user can see, with who, the period, amount, reason and who entered it. Excludes the user’s own.',
        input: z.object({}).strict(),
        run: async (_: unknown, ctx) => {
          need(ctx);
          const list = await pending(pool, ctx);
          if (!list.length) return { text: 'No sales overrides are waiting for your review.' };
          const total = list.reduce((s, a) => s + a.amount, 0);
          return {
            text: `**${list.length} sales ${list.length === 1 ? 'override is' : 'overrides are'}** waiting for your review, ${usd(total)} in all. None is in a payout until it’s approved.`,
            blocks: [moduleTable(spec, 'Sales overrides waiting for review', ctx.runId, 'gi.overrides.pending', [{ field: 'name', headerName: 'Person', type: 'text' }, { field: 'branch', headerName: 'Branch', type: 'text' }, { field: 'periodEnd', headerName: 'Period', type: 'date' }, { field: 'amount', headerName: 'Amount', type: 'currency' }, { field: 'reason', headerName: 'Reason', type: 'text' }, { field: 'note', headerName: 'Note', type: 'text' }, { field: 'by', headerName: 'Entered by', type: 'text' }], list.map((a) => ({ name: a.name, branch: a.branch, periodEnd: a.periodEnd, amount: a.amount, reason: a.reason, note: a.note, by: a.by })))],
            suggestions: list.slice(0, 2).map((a) => `Approve the adjustment for ${a.name}`),
          };
        },
      },
    ],
  };
  return spec;
}
