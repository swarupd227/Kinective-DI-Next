// @vitest-environment node
// Branch Performance: the CEO's six branch measures against target, delinquency at 30, 60 and 90 days,
// digital adoption, results per person and the complaint log, each for the viewer's branches beside the
// network, and nothing outside their purview.
import { describe, expect, it } from 'vitest';
import { blockSchema } from '@dinext/block-schemas';
import { BRANCH_TARGETS, BranchKpiService, NETWORK, meetsTarget, targetStatus } from '@dinext/di-core';
import { tenantPool, warehouseAvailable } from '@dinext/tenant-db';
import { BRANCH_KPI_REQUEST, branchKpiModule, branchKpiPlan, showMeasure } from '../src/index.ts';

describe('branch performance questions', () => {
  it('route to the right tool and leave other agents’ questions alone', () => {
    const cases: [string, string, Record<string, unknown>?][] = [
      ['How is Westport doing against the CEO’s targets?', 'bk_targets', { branch: 'Westport' }],
      ["Are we hitting the CEO's six metrics?", 'bk_targets', {}],
      ['Which branches are hitting the CEO’s targets?', 'bk_targets', {}],
      ['What’s our NPS by branch?', 'bk_targets', {}],
      ['Show Westport delinquency at 30, 60 and 90 days', 'bk_delinquency', { branch: 'Westport' }],
      ['Branch delinquency 30/60/90 days past due', 'bk_delinquency', {}],
      ['What’s digital adoption at my branch?', 'bk_digital', {}],
      ['How many active debit cards do we have by branch?', 'bk_digital', {}],
      ['Show staff productivity for my branch', 'bk_productivity', {}],
      ['How many loans per FTE did Westport do?', 'bk_productivity', { branch: 'Westport' }],
      ['Show the complaint log for my branch', 'bk_complaints', {}],
      ['Show complaints by branch', 'bk_complaints', {}],
      ['Show today’s teller balancing and the cash vault report for Westport', 'bk_balancing', { branch: 'Westport' }],
      ['Which tellers were out of balance this month?', 'bk_balancing', {}],
      ['What are our transactions per teller hour?', 'bk_balancing', {}],
      ['What are lobby wait times at Westport?', 'bk_lobby', { branch: 'Westport' }],
      ['How many CTRs did we file?', 'bk_risk', {}],
      ['Show structuring referrals and fraud losses by branch', 'bk_risk', {}],
      ['Any card skimming or elder exploitation at my branch?', 'bk_risk', {}],
      ['Show audit exceptions and surprise cash counts', 'bk_audit', {}],
      ['Were there any dual control exceptions?', 'bk_audit', {}],
      ['Who hasn’t finished BSA training?', 'bk_people', {}],
      ['What is staff turnover and engagement at my branch?', 'bk_people', {}],
    ];
    for (const [q, tool, args] of cases) {
      expect(BRANCH_KPI_REQUEST.test(q), q).toBe(true);
      const p = branchKpiPlan(q);
      expect(p.tool, q).toBe(tool);
      if (args) expect(p.args, q).toEqual(args);
    }
    for (const q of ['Which branches and products drive delinquency?', 'Show the pipeline by product for my branch', 'Show my overdue onboarding touch points', 'Who on my team is behind on goals?', 'Show Westport loans by category', 'Show my 30/60/90-day onboarding touch points', 'Which regulatory issues are open more than 3 weeks?', 'Does Suzanne Jackson have a debit card?', 'Show loan growth by branch for Q3 vs Q2', 'What did deposit balances do by product type over the last two quarters?', 'Show balances for all branches', 'Column stats for balance', 'Show the AI audit log'])
      expect(BRANCH_KPI_REQUEST.test(q), q).toBe(false);
  });

  it('scores each measure against its target', () => {
    expect(targetStatus('depositGrowthPct', 5.1)).toBe('below');
    expect(targetStatus('depositGrowthPct', 10)).toBe('in range');
    expect(targetStatus('newMembersPerMonth', 59.5)).toBe('above');
    expect(meetsTarget('newMembersPerMonth', 'above')).toBe(true);
    expect(targetStatus('nps', 70)).toBe('in range');
    expect(targetStatus('nps', 58)).toBe('below');
    expect(targetStatus('dq30Pct', 0.7)).toBe('in range');
    expect(targetStatus('dq30Pct', 1.27)).toBe('above');
    expect(meetsTarget('dq30Pct', 'above')).toBe(false);
    expect(BRANCH_TARGETS.productsPerMember).toMatchObject({ low: 3.5, high: 4.5 });
    expect(showMeasure('loanGrowthPct', -1.25)).toBe('−1.3%');
    expect(showMeasure('dq30Pct', 1.2673)).toBe('1.27%');
  });
});

const up = await warehouseAvailable('dinext_t_test_cu').then((ok) => ok && tenantPool('dinext_t_test_cu').query('SELECT 1 FROM cdm_survey LIMIT 1').then(() => true, () => false));
describe.skipIf(!up)('branch performance on the credit union', () => {
  it('computes the six measures, delinquency, digital, productivity and complaints, keeping to purview', async () => {
    const pool = tenantPool('dinext_t_test_cu');
    try {
      const svc = new BranchKpiService(pool);
      const all = await svc.targets();
      expect(all.lines.map((l) => l.branch)).toEqual(['Westport', 'Northgate', 'Riverside', 'Lakeshore', 'Downtown', 'Eastgate']);
      expect(all.network.branch).toBe(NETWORK);
      for (const l of [...all.lines, all.network]) {
        expect(l.scores).toHaveLength(6);
        expect(l.productsPerMember).toBeGreaterThan(1);
        expect(l.nps).toBeGreaterThan(-100);
        expect(l.nps).toBeLessThan(100);
      }
      // The network's growth sits between the slowest and fastest branch.
      const lg = all.lines.map((l) => l.loanGrowthPct);
      expect(all.network.loanGrowthPct).toBeGreaterThanOrEqual(Math.min(...lg));
      expect(all.network.loanGrowthPct).toBeLessThanOrEqual(Math.max(...lg));
      // New members a month for the network is per branch, so it compares with a branch target.
      const nm = all.lines.reduce((s, l) => s + l.newMembersPerMonth, 0) / all.lines.length;
      expect(all.network.newMembersPerMonth).toBeCloseTo(nm, 6);

      const mine = await svc.targets({ branches: ['Westport'] });
      expect(mine.lines.map((l) => l.branch)).toEqual(['Westport']);
      expect(mine.network.dq30Pct).toBeCloseTo(all.network.dq30Pct, 9);

      const dq = await svc.delinquency({ branches: ['Westport'] });
      const w = dq.lines[0]!;
      expect(w.ratio30).toBeGreaterThanOrEqual(w.ratio60);
      expect(w.ratio60).toBeGreaterThanOrEqual(w.ratio90);
      expect(w.ratio30).toBeCloseTo(mine.lines[0]!.dq30Pct, 9);

      const dg = await svc.digital();
      expect(dg.network.members).toBe(dg.lines.reduce((s, l) => s + l.members, 0));
      expect(dg.network.activeDebitPct).toBeGreaterThan(0);

      const pr = await svc.productivity({ branches: ['Westport'] });
      expect(pr.lines[0]!.staff).toBeGreaterThan(0);
      expect(pr.network.staff).toBeGreaterThan(pr.lines[0]!.staff);

      const cp = await svc.complaints({ branches: ['Westport'] });
      expect(cp.open.every((c) => c.branch === 'Westport')).toBe(true);
      expect(cp.lines[0]!.open).toBe(cp.open.length);
      expect(cp.network.open).toBeGreaterThanOrEqual(cp.lines[0]!.open);

      const spec = branchKpiModule(svc);
      const ctx = { user: { id: 'user:5120', name: 'Marcus Reed' }, purviewBranches: ['Westport'], modules: ['branchkpi'], runId: 'r', threadId: 't' };
      for (const tool of spec.tools) {
        const out = (await tool.run({} as never, ctx)) as { text: string; blocks: unknown[] };
        expect(out.text, tool.name).toMatch(/Westport/);
        expect(out.text, tool.name).not.toMatch(/Eastgate|Downtown|Northgate/);
        for (const b of out.blocks) expect(blockSchema.safeParse(b).success, tool.name).toBe(true);
      }
      const one = (await spec.tools.find((t) => t.name === 'bk_targets')!.run({} as never, ctx)) as { text: string };
      expect(one.text).toMatch(/\*\*Westport meets \d of the CEO’s 6 targets\*\*/);
      const exec = (await spec.tools.find((t) => t.name === 'bk_targets')!.run({} as never, { ...ctx, purviewBranches: undefined })) as { text: string; blocks: { data: { rows: unknown[] } }[] };
      expect(exec.blocks[0]!.data.rows).toHaveLength(7);
      await expect(spec.tools[0]!.run({ branch: 'Eastgate' } as never, ctx)).rejects.toThrow(/outside the branches you can see, so I can’t show Eastgate/);
      // A word that isn't a branch narrows nothing.
      expect(((await spec.tools[0]!.run({ branch: 'Reg' } as never, ctx)) as { text: string }).text).toMatch(/Westport meets/);
      await expect(spec.tools[0]!.run({} as never, { ...ctx, modules: [] })).rejects.toThrow(/isn’t part of your DI access/);
    } finally {
      await pool.end();
    }
  });
});

describe('branch operations seed', () => {
  it('is the same every run and tells Westport’s story', async () => {
    const { generateBranchOps, BRANCH_OPS_TABLES, BRANCH_OPS_COLUMNS } = await import('../../tenant-db/src/branchOps.ts');
    const roster = [1, 2, 3, 4, 5, 6].flatMap((b) => [1, 2, 3, 4, 5, 6].map((k) => [(b - 1) * 100 + k, `Person ${b}${k}`, k < 3 ? 'Loan officer' : k < 6 ? 'MSR' : 'Branch manager', b]));
    const a = generateBranchOps(roster);
    expect(generateBranchOps(roster)).toEqual(a);
    for (const t of BRANCH_OPS_TABLES) for (const row of a[t]!) expect(row, t).toHaveLength(BRANCH_OPS_COLUMNS[t]!.length);
    // Teller 5 at Westport is out of balance more than anyone; Westport's vault runs over its limit on Fridays.
    const off = (id: number) => a.bro_teller_day!.filter((r) => r[2] === id && r[6] !== 0).length;
    expect(off(5)).toBeGreaterThan(Math.max(...roster.filter((e) => e[2] === 'MSR' && e[0] !== 5).map((e) => off(e[0] as number))));
    expect(a.bro_vault_day!.some((r) => r[1] === 1 && Number(r[2]) > Number(r[3]))).toBe(true);
    // The surprise count that found a $20 shortage had no second person.
    expect(a.bro_cash_count!.some((r) => r[1] === 1 && r[4] === 5 && Number(r[6]) - Number(r[5]) === -20 && r[7] === 0)).toBe(true);
    // CTRs are over $10,000; required training covers everyone.
    expect(a.bro_ctr!.every((r) => Number(r[4]) > 10_000)).toBe(true);
    expect(a.bro_training!.filter((r) => r[2] === 1)).toHaveLength(roster.length * 3);
  });
});

const opsUp = up && (await tenantPool('dinext_t_test_cu').query('SELECT 1 FROM bro_teller_day LIMIT 1').then(() => true, () => false));
describe.skipIf(!opsUp)('branch operations on the credit union', () => {
  it('reports balancing, lobby, BSA and fraud, audits and people within purview', async () => {
    const pool = tenantPool('dinext_t_test_cu');
    try {
      const svc = new BranchKpiService(pool);
      const w = { branches: ['Westport'] };
      const bal = await svc.balancing(w);
      expect(bal.lines.map((l) => l.branch)).toEqual(['Westport']);
      expect(bal.people.every((t) => t.branch === 'Westport')).toBe(true);
      expect(bal.network.drawers).toBeGreaterThan(bal.lines[0]!.drawers);
      expect(bal.lines[0]!.txPerHour).toBeGreaterThan(5);
      const lobby = await svc.lobby(w);
      expect(lobby.lines[0]!.avgWait).toBeGreaterThan(0);
      expect(lobby.lines[0]!.busiest).not.toBeNull();
      const risk = await svc.risk(w);
      expect(risk.lines[0]!.ctrs).toBeGreaterThan(0);
      expect(risk.network.fraudCases).toBeGreaterThanOrEqual(risk.lines[0]!.fraudCases);
      expect(risk.lines[0]!.netLoss).toBeCloseTo(risk.lines[0]!.byType.reduce((s, t) => s + t.loss, 0), 2);
      const audits = await svc.audits(w);
      expect(audits.open.every((e) => e.branch === 'Westport')).toBe(true);
      expect(audits.lines[0]!.openHigh).toBeGreaterThan(0);
      const people = await svc.people(w);
      expect(people.lines[0]!.headcount).toBe(6);
      expect(people.lines[0]!.trainingPct).toBeLessThan(100);
      expect(people.incomplete.every((t) => t.branch === 'Westport')).toBe(true);

      const spec = branchKpiModule(svc);
      const ctx = { user: { id: 'user:5120', name: 'Marcus Reed' }, purviewBranches: ['Westport'], modules: ['branchkpi'], runId: 'r', threadId: 't' };
      const run = async (name: string) => (await spec.tools.find((t) => t.name === name)!.run({} as never, ctx)) as { text: string };
      expect((await run('bk_risk')).text).toMatch(/SARs aren’t shown by branch/);
      expect((await run('bk_balancing')).text).toMatch(/transactions an hour/);
      // The operations reports cite the operations tables, not the month-end ones.
      for (const name of ['bk_balancing', 'bk_lobby', 'bk_risk', 'bk_audit', 'bk_people']) {
        const out = (await spec.tools.find((t) => t.name === name)!.run({} as never, ctx)) as { blocks: { provenance: { sources: { ref: string }[] } }[] };
        for (const b of out.blocks) expect(b.provenance.sources.every((x) => x.ref.startsWith('table:bro_')), name).toBe(true);
      }
      expect((await run('bk_people')).text).toMatch(/against 100%/);
    } finally {
      await pool.end();
    }
  });
});
