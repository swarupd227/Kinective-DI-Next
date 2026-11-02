// @vitest-environment node
// Indirect Lending and Prospecting on the shared agent, against the seeded warehouse. No model calls.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ApprovalStore, IndirectService, ProspectService, SegService, miles, visitOrder } from '@dinext/di-core';
import { createPool, tenantPool, warehouseAvailable, type Pool } from '@dinext/tenant-db';
import { ModuleGateway, indirectModule, prospectingModule, runModuleOffline, segModule, type ModuleSpec, type ModuleTurn, type RunSink } from '../src/index.ts';

const SCHEMA = 'dinext_t_test_cu';
const up = await warehouseAvailable(SCHEMA).then((ok) => ok && tenantPool(SCHEMA).query('SELECT 1 FROM ind_dealer LIMIT 1').then(() => true, () => false));

const recorder = () => {
  const texts: string[] = [];
  const sink: RunSink = { signal: new AbortController().signal, routing: () => {}, plan: () => 'blk_plan00000000', step: () => {}, text: async (m) => void texts.push(m), block: async () => {}, suggestion: () => {} };
  return { sink, texts };
};

describe('distances and visit order', () => {
  it('measures miles and visits the nearest stop next', () => {
    expect(miles([42.65, -73.76], [42.65, -73.76])).toBe(0);
    expect(Math.round(miles([42.65, -73.76], [42.75, -73.76]))).toBe(7);
    const order = visitOrder([0, 0], [{ id: 'far', at: [0, 0.3] as const }, { id: 'near', at: [0, 0.1] as const }]);
    expect(order.map((s) => s.id)).toEqual(['near', 'far']);
  });
});

describe.skipIf(!up)('indirect lending and prospecting against the warehouse', () => {
  let pool: Pool;
  let admin: Pool;
  let ind: IndirectService;
  let prs: ProspectService;
  let gateway: ModuleGateway;
  let indirect: ModuleSpec;
  let prospecting: ModuleSpec;
  const turn = (text: string, modules: string[], purviewBranches?: string[]): ModuleTurn => ({ runId: 'R-test', threadId: `thr_${Math.random().toString(36).slice(2, 10)}`, text, user: { id: 'user:5120', name: 'Marcus Reed', title: 'Branch manager' }, tenant: { name: 'Harborview' }, modules, purviewBranches });
  const run = async (spec: ModuleSpec, t: ModuleTurn) => {
    const r = recorder();
    const out = await runModuleOffline(spec, t, { gateway }, r.sink);
    return { text: r.texts[0]!, out, t };
  };
  const approve = async (o: Awaited<ReturnType<typeof run>>) => {
    const approvals = new ApprovalStore(pool);
    const a = await approvals.decide(o.out.approval!.record.approvalId, { decision: 'approved', userId: o.t.user.id, payloadHash: o.out.approval!.record.payloadHash });
    await gateway.execute(a, { user: o.t.user, modules: o.t.modules, purviewBranches: o.t.purviewBranches, runId: o.t.runId, threadId: o.t.threadId });
  };

  beforeAll(async () => {
    pool = tenantPool(SCHEMA);
    admin = createPool(`${process.env.DI_DB_ADMIN_URL ?? 'mysql://root:dinext_local_root@127.0.0.1:3307'}/${SCHEMA}`);
    ind = new IndirectService(pool);
    prs = new ProspectService(pool);
    const [d] = (await pool.query('SELECT name FROM ind_dealer ORDER BY dealer_id')) as unknown as [{ name: string }[]];
    const [c] = (await pool.query('SELECT company FROM prs_prospect ORDER BY prospect_id')) as unknown as [{ company: string }[]];
    const { stages } = await prs.config();
    indirect = indirectModule(ind, d.map((x) => x.name), () => '2026-10-25');
    prospecting = prospectingModule(prs, c.map((x) => x.company), stages, () => '2026-10-25');
    gateway = new ModuleGateway(new ApprovalStore(pool), [indirect, prospecting, segModule(new SegService(pool), () => '2026-10-25')]);
  });
  afterAll(async () => {
    await admin.query("DELETE FROM ind_visit WHERE note LIKE 'Test visit%'");
    await admin.query("UPDATE ind_dealer SET ytd_visits = 2, last_visited = '2026-07-03', rep = 'Ana Ruiz' WHERE name = 'Smith Ford'");
    await admin.query("DELETE FROM prs_activity WHERE approval_id IS NOT NULL");
    await admin.query("UPDATE prs_prospect SET stage = 'Suspect', disposition = 'Interested' WHERE company = 'Acme Manufacturing'");
    await pool.end();
    await admin.end();
  });

  it('routes each request, and leaves SEG’s requests to SEG', () => {
    const cases: [string, string][] = [['How did Smith Ford do this quarter compared with last?', 'indirect'], ['Which dealers had the biggest drop in funded loans this month?', 'indirect'], ['How many indirect borrowers became direct members this year?', 'indirect'], ['Show my prospects in Qualified with assets over $5 million', 'prospecting'], ['Log a call with Acme Manufacturing: no answer, try Thursday', 'prospecting'], ['Move Acme Manufacturing to Pre-Qualified', 'prospecting'], ['Log a SEG call with Acme HR', 'seg'], ['Move Acme HR to Proposal for the SEG', 'seg']];
    for (const [t, id] of cases) expect(gateway.match(t)?.id, t).toBe(id);
    expect(gateway.match('Find the dealer agreement for Smith Ford')?.id).not.toBe('indirect');
  });

  describe('indirect lending', () => {
    it('takes funded loans from the warehouse’s own indirect loans', async () => {
      const p = await ind.performance('month', {});
      const [[r]] = (await pool.query(`SELECT COUNT(*) AS n FROM cdm_loan WHERE is_indirect = 1 AND DATE_FORMAT(open_date, '%Y-%m') = ?`, [p.months[0]])) as unknown as [[{ n: number }]];
      expect(p.dealers.reduce((n, d) => n + d.funded, 0)).toBe(Number(r.n));
      expect(p.dealers.every((d) => d.approved <= d.received)).toBe(true);
    });

    it('compares a dealer with the period before, and ranks the drops', async () => {
      const one = await run(indirect, turn('How did Smith Ford do this quarter compared with last?', ['indirect']));
      expect(one.text).toMatch(/Smith Ford\*\* funded \*\*\d+ loans\*\*/);
      expect(one.text).toContain('Q4 2026 to date');
      const all = await run(indirect, turn('Which dealers had the biggest drop in funded loans this month?', ['indirect']));
      expect(all.text).toMatch(/dealers in October 2026 to date/);
      expect(all.text).toContain('isn’t over yet');
    });

    it('plans visits from a branch, nearest first, with a directions link', async () => {
      const v = await ind.planVisits(5, 'Westport', {});
      expect(v.stops).toHaveLength(5);
      expect(v.directions).toContain('google.com/maps/dir');
      const { text } = await run(indirect, turn('Plan visits for my top five dealers near Westport', ['indirect']));
      expect(text).toContain('Visit order from Westport');
    });

    it('logs a visit: one more this year, and today as the last visit', async () => {
      const o = await run(indirect, turn('Log a visit to Smith Ford: Test visit, met the finance manager', ['indirect']));
      expect(o.out.approval!.card.data.riskTier).toBe('low');
      const before = await ind.dealer('Smith Ford', {});
      await approve(o);
      const after = await ind.dealer('Smith Ford', {});
      expect(after.ytdVisits).toBe(before.ytdVisits + 1);
      expect(after.lastVisited).toBe('2026-10-25');
    });

    it('makes a rep change medium risk, and keeps indirect-to-direct to its permission', async () => {
      const o = await run(indirect, turn('Make Tom Walsh the rep for Smith Ford', ['indirect']));
      expect(o.out.approval!.card.data.riskTier).toBe('medium');
      expect((await run(indirect, turn('How many indirect borrowers became direct members this year?', ['indirect']))).text).toContain('needs its own permission');
      expect((await run(indirect, turn('How many indirect borrowers became direct members this year?', ['indirect', 'indirect-direct']))).text).toMatch(/of [\d,]+ indirect borrowers/);
      expect((await run(indirect, turn('Which dealers fell most?', []))).text).toContain('isn’t part of your DI access');
    });
  });

  describe('prospecting', () => {
    it('filters by stage and assets, and keeps to the purview', async () => {
      const q = await prs.list({ stage: 'Qualified', minAssets: 5e6 }, {});
      expect(q.every((p) => p.stage === 'Qualified' && p.assets >= 5e6)).toBe(true);
      const west = await prs.list({}, { purviewBranches: ['Westport'] });
      expect(west.length).toBeGreaterThan(0);
      expect(west.every((p) => p.branch === 'Westport')).toBe(true);
    });

    it('routes to prospects inside the radius only', async () => {
      const r = await prs.route('Westport', 10, {});
      expect(r.stops.every((s) => s.away <= 10)).toBe(true);
      const all = await prs.route('Westport', 60, {});
      expect(all.stops.length).toBeGreaterThanOrEqual(r.stops.length);
    });

    it('logs a call and moves a stage, both on the timeline', async () => {
      const call = await run(prospecting, turn('Log a call with Acme Manufacturing: no answer, try Thursday', ['prospecting']));
      expect(call.out.approval!.card.data.riskTier).toBe('low');
      await approve(call);
      const move = await run(prospecting, turn('Move Acme Manufacturing to Pre-Qualified', ['prospecting']));
      expect(move.out.approval!.card.data.riskTier).toBe('medium');
      await approve(move);
      const acme = await prs.find('Acme Manufacturing', {});
      expect(acme.stage).toBe('Pre-Qualified');
      expect(acme.disposition).toBe('No answer');
      const line = await prs.timeline(acme.prospectId);
      expect(line.map((l) => l.kind).slice(0, 2).sort()).toEqual(['Call', 'Stage change']);
    });

    it('reports conversion between stages, and refuses them backwards', async () => {
      const { text } = await run(prospecting, turn('What’s our conversion from Prospect to Application this quarter?', ['prospecting']));
      expect(text).toMatch(/\*\*[\d.]+%\*\*: of the \d+ prospects that entered Prospect/);
      await expect(prs.conversion('Application', 'Prospect', { start: '2026-07-01', end: '2026-10-25' }, {})).rejects.toThrow(/comes before/);
    });
  });
});
