// @vitest-environment node
// Lineage and AI governance on the shared agent, against the seeded warehouse. No model calls.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { validateBlock, type Block, type LineageGraphBlock } from '@dinext/block-schemas';
import { ApprovalStore, GovernanceService, LineageService } from '@dinext/di-core';
import { loadModel } from '@dinext/semantic';
import { tenantPool, warehouseAvailable, type Pool } from '@dinext/tenant-db';
import { AuditLog, governanceModule, lineageModule, ModuleGateway, runModuleOffline, type ModuleSpec, type ModuleTurn, type RunSink } from '../src/index.ts';
import { prescreen } from '../src/prescreen.ts';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const SCHEMA = 'dinext_t_test_cu';
const up = await warehouseAvailable(SCHEMA).then((ok) => ok && tenantPool(SCHEMA).query('SELECT 1 FROM ai_run LIMIT 1').then(() => true, () => false));

function recorder() {
  const blocks: Block[] = [];
  const texts: string[] = [];
  const sink: RunSink = { signal: new AbortController().signal, routing: () => {}, plan: () => 'blk_plan00000000', step: () => {}, text: async (m) => void texts.push(m), block: async (b) => void blocks.push(b), suggestion: () => {} };
  return { sink, blocks, texts };
}

describe.skipIf(!up)('trust and governance against the warehouse', () => {
  let pool: Pool;
  let gateway: ModuleGateway;
  let lineage: ModuleSpec;
  let gov: ModuleSpec;
  let service: GovernanceService;
  const model = loadModel('test_cu', 'credit_union');
  const turn = (text: string, threadId: string, over: Partial<ModuleTurn> = {}): ModuleTurn => ({ runId: `R-test-${threadId}`, threadId, text, user: { id: 'user:1002', name: 'Sam Taylor', title: 'DI Administrator' }, tenant: { name: 'Harborview' }, modules: ['lineage', 'ai-admin'], ...over });
  const run = async (spec: ModuleSpec, t: ModuleTurn) => {
    const r = recorder();
    return { r, out: await runModuleOffline(spec, t, { gateway }, r.sink) };
  };

  beforeAll(() => {
    pool = tenantPool(SCHEMA);
    service = new GovernanceService(pool);
    lineage = lineageModule(new LineageService(pool, model));
    gov = governanceModule(service, () => 2026);
    gateway = new ModuleGateway(new ApprovalStore(pool), [lineage, gov]);
  });
  afterAll(() => pool.end());

  it('routes requests to lineage and governance', () => {
    const cases: [string, string][] = [['Where does 60+ delinquency come from?', 'lineage'], ['Trace total loan balance to its source', 'lineage'], ['What breaks if we change cdm_loan.days_delinquent?', 'lineage'], ['Show AI cost by agent for October', 'governance'], ['Who used the most tokens last week?', 'governance'], ['Open the trace for run R-20261026-0042', 'governance'], ['Show every high-risk approval made through agents this month', 'governance'], ['How much have I used this month?', 'governance'], ['Show the negative feedback', 'governance']];
    for (const [t, id] of cases) expect(gateway.match(t)?.id, t).toBe(id);
    expect(gateway.match('Show loan growth by branch')).toBeNull();
  });

  describe('lineage', () => {
    it('traces a metric to its source with load times and data quality', async () => {
      const { r } = await run(lineage, turn('Where does 60+ delinquency come from?', 'thr_l1'));
      const graph = r.blocks[0] as LineageGraphBlock;
      expect(validateBlock(graph).ok).toBe(true);
      const lane = graph.data.lanes.find((l) => l.nodes[0]!.detail?.startsWith('cdm_loan'))!;
      expect(lane.nodes[0]!.detail).toContain('days_delinquent');
      expect(lane.nodes.map((n) => n.kind)).toEqual(['table', 'load', 'file', 'source']);
      expect(lane.nodes[0]!.lastLoad).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/);
      expect(lane.nodes[0]!.dq?.state).toBe('failed');
      expect(r.texts[0]).toContain('checks failed');
    });

    it('shows a gap as an unknown source and says so, instead of inferring it', async () => {
      const bare = lineageModule(new LineageService(pool, model, {}));
      const r = recorder();
      await runModuleOffline(bare, turn('Where does total loan balance come from?', 'thr_l2'), { gateway: new ModuleGateway(new ApprovalStore(pool), [bare]) }, r.sink);
      const graph = r.blocks[0] as LineageGraphBlock;
      expect(graph.data.lanes[0]!.nodes.at(-1)).toMatchObject({ kind: 'unknown', label: 'Unknown source' });
      expect(r.texts[0]).toContain('unknown source');
    });

    it('lists what depends on a column', async () => {
      const { r } = await run(lineage, turn('What breaks if we change cdm_loan.days_delinquent?', 'thr_l3'));
      expect(r.texts[0]).toMatch(/would affect \*\*\d+ measures?\*\*/);
      expect(JSON.stringify(r.blocks[0])).toContain('Delinquency ratio');
    });

    it('asks which number when none is named, and keeps to access', async () => {
      const { out, r } = await run(lineage, turn('Where does this number come from?', 'thr_l4'));
      expect(out.asked).toBe(true);
      expect(r.texts[0]).toContain('Which number');
      const closed = await run(lineage, turn('Where does delinquency come from?', 'thr_l5', { modules: [] }));
      expect(closed.r.texts[0]).toContain('isn’t part of your DI access');
    });
  });

  describe('AI usage', () => {
    it('reports October by agent, and the rows add up to the total', async () => {
      const { r } = await run(gov, turn('Show AI cost by agent for October', 'thr_g1'));
      expect(r.texts[0]).toContain('October 2026');
      expect(validateBlock(r.blocks[0]!).ok).toBe(true);
      const u = await service.usage('2026-10', 'agent');
      expect(u.items.reduce((n, i) => n + i.prompts, 0)).toBe(u.totals.prompts);
      expect((await service.usage('2026-10', 'class')).totals.cost).toBeCloseTo(u.totals.cost, 4);
    });

    it('refuses other people’s usage without the permission, but shows your own', async () => {
      const denied = await run(gov, turn('Who used the most tokens in October?', 'thr_g2', { modules: [] }));
      expect(denied.r.texts[0]).toContain('AI usage permission');
      const own = await run(gov, turn('How much have I used this month?', 'thr_g3', { modules: [] }));
      expect(own.r.texts[0]).toMatch(/you ran \*\*/);
    });

    it('opens a trace, for your own run or with the permission', async () => {
      const [[row]] = (await pool.query("SELECT run_id, user_id FROM ai_run WHERE source = 'demo' AND user_id <> 'user:6004' LIMIT 1")) as unknown as [[{ run_id: string; user_id: string }]];
      const admin = await run(gov, turn(`Open the trace for run ${row.run_id}`, 'thr_g4'));
      expect(admin.r.texts[0]).toContain(row.run_id);
      expect(JSON.stringify(admin.r.blocks[0])).toContain('Tool call');
      const stranger = await run(gov, turn(`Open the trace for run ${row.run_id}`, 'thr_g5', { modules: [], user: { id: 'user:6004', name: 'Sofia Ruiz', title: 'MSR' } }));
      expect(stranger.r.texts[0]).toContain('that you can see');
    });

    it('lists high-risk approvals with the run they came from', async () => {
      const { r } = await run(gov, turn('Show every high-risk approval made through agents in October', 'thr_g6'));
      expect(r.texts[0]).toContain('high-risk approval');
      expect(JSON.stringify(r.blocks[0])).toContain('Create user Ana Ruiz');
    });
  });

  it('keeps a run ID readable but still masks an account number', () => {
    expect(prescreen('Open the trace for run R-20261102-b1a9').text).toContain('R-20261102-b1a9');
    expect(prescreen('Look up account 20261102').text).not.toContain('20261102');
    expect(prescreen('R-20261102 is my account').text).not.toContain('20261102');
  });

  it('writes each turn to the ledger through the audit log', async () => {
    const audit = new AuditLog(mkdtempSync(join(tmpdir(), 'di-audit-')));
    const seen: string[] = [];
    audit.ledger('test_cu', async (r) => void seen.push(`${r.runId}:${r.route.label}`));
    await audit.record({ tenant: 'test_cu', userId: 'u', threadId: 't', runId: 'R-1', question: 'q', maskedIdentifiers: 0, route: { intent: 'module_task', agent: 'none', confidence: 1, mode: 'offline', label: 'Data Lineage' }, toolCalls: [], outcome: 'answer', numericRemovals: [], usage: [] });
    expect(seen).toEqual(['R-1:Data Lineage']);
  });

  it('lets the application add to the ledger but not change it', async () => {
    await expect(pool.query("UPDATE ai_run SET outcome = 'x' LIMIT 1")).rejects.toThrow(/denied/i);
    await expect(pool.query('DELETE FROM ai_feedback')).rejects.toThrow(/denied/i);
  });
});
