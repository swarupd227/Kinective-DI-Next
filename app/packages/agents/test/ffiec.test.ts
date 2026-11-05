// The FFIEC 051 Call Report for the bank: the report ties together (validity edits), the story a CFO
// will be asked about (a blocking GL mapping, nonaccrual and uninsured deposits up), CBLR capital, CRE
// concentration, and the figures it feeds (bank ROA and NIM, ALCO capital) come from it.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AlcoService, CallReportService } from '@dinext/di-core';
import { SemanticService } from '@dinext/semantic';
import { tenantPool, warehouseAvailable, type Pool } from '@dinext/tenant-db';
import { ffiecModule } from '../src/index.ts';

describe('Call Report questions at a bank', () => {
  const spec = ffiecModule({} as CallReportService);
  const plan = (t: string) => spec.plan(t, {} as never);
  it('routes each question to the right tool, and never submits', () => {
    expect(plan('Are we ready to file the Call Report?')).toEqual({ tool: 'cr_readiness', args: {} });
    expect(plan('How is RCON2122 built?')).toEqual({ tool: 'cr_line_explain', args: { code: 'RCON2122' } });
    expect(plan('What is our CRE concentration?')).toEqual({ tool: 'cr_concentration', args: {} });
    expect(plan('Show capital')).toEqual({ tool: 'cr_capital', args: {} });
    expect(plan('Show RC-N')).toEqual({ tool: 'cr_schedule', args: { schedule: 'RC-N' } });
    expect(plan('Submit the Call Report')).toEqual({ say: expect.stringMatching(/stays a person’s action/) });
  });
});

const SCHEMA = 'dinext_t_test_bank';
const up = await warehouseAvailable(SCHEMA);

describe.skipIf(!up)('the FFIEC 051 on the warehouse', () => {
  let pool: Pool;
  let cr: CallReportService;
  beforeAll(() => {
    pool = tenantPool(SCHEMA);
    cr = new CallReportService(pool);
  });
  afterAll(async () => pool.end());

  it('balances, and every validity edit but the GL mapping passes', async () => {
    const lines = await cr.lines();
    const v = (c: string) => lines.find((l) => l.code === c)!.current!;
    expect(v('RCON2170')).toBe(v('RCON3300'));
    expect(v('RCON2122')).toBe(v('RCONB528'));
    expect(v('RIAD4074')).toBe(v('RIAD4107') - v('RIAD4073'));
    expect(v('RCON2215') + v('RCON2385')).toBe(v('RCON2200'));
    // A community bank's shape: equity about 9.5% of assets, securities a quarter of it.
    expect(v('RCON3210') / v('RCON2170')).toBeGreaterThan(0.09);
    expect((v('RCON1754') + v('RCON1773')) / v('RCON2170')).toBeGreaterThan(0.2);
    const r = await cr.readiness();
    expect((await cr.form()).form).toBe('FFIEC 051');
    expect(r.errors.map((e) => e.name)).toEqual(['GL accounts categorized']);
    expect(r.warnings.map((w) => w.name)).toEqual(expect.arrayContaining(['Nonaccrual loans moved less than 25% from Q2 2026', 'Uninsured deposits moved less than 15% from Q2 2026']));
    expect(r.quarter.dueDate).toBe('2026-10-30');
  });

  it('builds totals from their items, with MDRM codes', async () => {
    const l = await cr.line('RCON2122');
    expect(l.parts.map((p) => p.code)).toEqual(['RCONF159', 'RCON1797', 'RCON5367', 'RCON1460', 'RCONF160', 'RCONF161', 'RCON1766', 'RCONB538', 'RCONK137', 'RCONK207']);
    expect(l.parts.reduce((s, p) => s + (p.current ?? 0), 0)).toBe(l.current);
  });

  it('feeds the bank’s ROA, NIM and leverage, and the ALCO pack’s capital', async () => {
    const svc = await SemanticService.create(pool, 'test_bank', 'bank');
    const q = await svc.query({ metrics: ['return_on_assets', 'net_interest_margin', 'net_worth_ratio'] }, { canViewSql: false });
    expect(Number(q.rows[0]!.return_on_assets)).toBeGreaterThan(0.8);
    expect(Number(q.rows[0]!.net_interest_margin)).toBeGreaterThan(3);
    expect(svc.model.metrics.net_worth_ratio!.label).toBe('Tier 1 leverage ratio');
    expect(svc.definition('return_on_assets').description).not.toMatch(/5300/);
    const a = await new AlcoService(pool, 'bank').analysis();
    expect(a.capital.basis).toMatch(/FFIEC 051 Call Report/);
    expect(a.policy.find((p) => p.measure === 'Tier 1 leverage ratio (CBLR)')?.status).toBe('Within');
    expect(a.policy.find((p) => p.measure === 'Non-owner-occupied CRE to capital')).toBeTruthy();
  });

  it('answers as the Call Report agent', async () => {
    const spec = ffiecModule(cr);
    const ctx = { user: { id: 'u', name: 'Elena Ortiz' }, modules: ['callreport'], runId: 'R-ff', threadId: 't' };
    const run = async (q: string) => {
      const p = spec.plan(q, ctx as never) as { tool: string; args: never };
      return ((await spec.tools.find((t) => t.name === p.tool)!.run(p.args, ctx as never)) as { text: string }).text;
    };
    expect(await run('Are we ready to file the Call Report?')).toMatch(/FFIEC 051 \*\*isn’t ready yet\*\*.*1295.*Central Data Repository/s);
    expect(await run('Show capital')).toMatch(/community bank leverage ratio.*well capitalized/s);
    expect(await run('What is our CRE concentration?')).toMatch(/of Tier 1 capital plus the allowance.*300%/s);
  });
});
