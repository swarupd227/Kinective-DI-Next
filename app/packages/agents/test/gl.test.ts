// @vitest-environment node
// General Ledger: statements that balance and tie to the Call Report, budget against actual by department,
// and journal entries that reconcile from opening to closing.
import { describe, expect, it } from 'vitest';
import { blockSchema } from '@dinext/block-schemas';
import { GlService } from '@dinext/di-core';
import { tenantPool, warehouseAvailable } from '@dinext/tenant-db';
import { GL_REQUEST, glModule, glPlan, monthIn } from '../src/index.ts';

describe('general ledger questions', () => {
  it('route to the right tool, and leave the board’s targets and 5300 mapping elsewhere', () => {
    const cases: [string, string][] = [
      ['Show the balance sheet', 'gl_statement'],
      ['Show the income statement for September by account', 'gl_statement'],
      ['Which departments are over budget this year?', 'gl_budget'],
      ['Show budget vs actual by cost center', 'gl_budget'],
      ['Show the journal entries for marketing in September', 'gl_journal'],
      ['Show the balance sheet for the last six months', 'gl_compare'],
      ['Show the consolidated balance sheet as of October 15', 'gl_statement'],
    ];
    for (const [q, tool] of cases) {
      expect(GL_REQUEST.test(q), q).toBe(true);
      expect(glPlan(q).tool, q).toBe(tool);
    }
    expect(glPlan('Show the consolidated balance sheet as of October 15').args).toMatchObject({ kind: 'BS', day: '2026-10-15' });
    expect(glPlan('Show the journal entries for marketing in September').args).toEqual({ account: 'marketing', month: '2026-09-30' });
    expect(glPlan('Which departments are over budget this year?').args).toEqual({ by: 'department', ytd: true });
    expect(GL_REQUEST.test('Which GL accounts are uncategorized?')).toBe(false);
    expect(GL_REQUEST.test('Draft next year’s budget')).toBe(false);
    // "Marketing" isn't March, and a bare "may" isn't May.
    expect(monthIn('marketing spend')).toBeUndefined();
    expect(monthIn('What may we spend?')).toBeUndefined();
    expect(monthIn('December')).toBe('2025-12-31');
  });
});

for (const schema of ['dinext_t_test_cu', 'dinext_t_test_bank']) {
  const up = await warehouseAvailable(schema).then((ok) => ok && tenantPool(schema).query('SELECT 1 FROM gl_balance_month LIMIT 1').then(() => true, () => false));
  describe.skipIf(!up)(`the general ledger, ${schema}`, () => {
    it('balances every period, ties to the Call Report, and reconciles its journals', async () => {
      const pool = tenantPool(schema);
      try {
        const svc = new GlService(pool);
        const meta = await svc.meta();
        for (const o of [{ month: '2025-12-31' }, { month: '2026-06-30' }, { month: '2026-09-30' }, { day: meta.latestDay }]) {
          for (const scope of [1, 'consolidated'] as const) {
            const t = (await svc.statement('BS', { ...o, scope })).totals as { assets: number[]; liabilities: number[]; equity: number[] };
            expect(Math.abs(t.assets[0]! - t.liabilities[0]! - t.equity[0]!), `${JSON.stringify(o)} ${scope}`).toBeLessThan(1);
          }
        }
        // September 30 is the Call Report's general ledger, account by account.
        const sep = (await svc.statement('BS', { month: '2026-09-30', scope: 1 })).groups.flatMap((g) => g.accounts);
        for (const a of sep) {
          const [row] = ((await pool.query('SELECT balance FROM cr_gl_account WHERE gl_number = ?', [a.gl]))[0] as { balance: string }[]);
          if (row) expect(Math.abs(Math.abs(a.values[0]!) - Math.abs(Number(row.balance))), a.gl).toBeLessThan(0.01);
        }
        // Year-to-date income ties to the Call Report's income accounts.
        const ytd = (await svc.statement('IS', { month: '2026-09-30', scope: 1 })).groups.flatMap((g) => g.accounts);
        for (const a of ytd.slice(0, 5)) {
          const [row] = ((await pool.query('SELECT balance FROM cr_gl_account WHERE gl_number = ?', [a.gl]))[0] as { balance: string }[]);
          expect(Math.abs(a.values.at(-1)! - Number(row!.balance)), a.gl).toBeLessThan(1);
        }
        // Journals: opening plus entries equals closing, for a balance-sheet and an expense account, both months.
        const [bsAcct] = sep.filter((a) => a.type === 'liability');
        const [exp] = ytd.filter((a) => a.type === 'expense');
        for (const acct of [bsAcct!.gl, exp!.gl]) for (const month of ['2026-09-30', meta.openMonth]) expect((await svc.journal(acct, { month })).ties, `${acct} ${month}`).toBe(true);
        const b = await svc.budget({ ytd: true });
        expect(b.lines.some((l) => !l.favorable)).toBe(true);

        const ctx = { user: { id: 'u', name: 'Elena Ortiz' }, modules: ['gl'], runId: 'r', threadId: 't' };
        const spec = glModule(svc);
        const tool = (n: string) => spec.tools.find((x) => x.name === n)!;
        for (const [name, args] of [['gl_statement', { kind: 'BS', accounts: true }], ['gl_statement', { kind: 'IS' }], ['gl_compare', { kind: 'IS', months: 6 }], ['gl_budget', { ytd: true }], ['gl_journal', { account: bsAcct!.gl }]] as const) {
          const out = (await tool(name).run(args as never, ctx)) as { text: string; blocks?: unknown[] };
          expect(out.text.length, name).toBeGreaterThan(30);
          for (const blk of out.blocks ?? []) expect(blockSchema.safeParse(blk).success, name).toBe(true);
        }
        expect(((await tool('gl_statement').run({ kind: 'BS' } as never, ctx)) as { text: string }).text).toContain('The balance sheet balances.');
        await expect(tool('gl_budget').run({} as never, { ...ctx, modules: [] })).rejects.toThrow(/isn’t part of your DI access/);
      } finally {
        await pool.end();
      }
    }, 60_000);
  });
}
