// @vitest-environment node
// Queries, the calendar and files against the seeded warehouse. No model calls.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ApprovalStore, CalendarService, IssueService, OnboardingService, QueryService, RetentionService, findFiles } from '@dinext/di-core';
import { tenantPool, warehouseAvailable, type Pool } from '@dinext/tenant-db';
import { ModuleGateway, calendarModule, filesModule, runModuleOffline, type ModuleContext, type ModuleSpec, type ModuleTurn, type RunSink } from '../src/index.ts';

const SCHEMA = 'dinext_t_test_cu';
const up = await warehouseAvailable(SCHEMA);

const recorder = () => {
  const texts: string[] = [];
  const sink: RunSink = { signal: new AbortController().signal, routing: () => {}, plan: () => 'blk_plan00000000', step: () => {}, text: async (m) => void texts.push(m), block: async () => {}, suggestion: () => {} };
  return { sink, texts };
};

describe.skipIf(!up)('workspace apps against the warehouse', () => {
  let pool: Pool;
  let queries: QueryService;
  let calendar: CalendarService;
  let gateway: ModuleGateway;
  let cal: ModuleSpec;
  let files: ModuleSpec;
  const turn = (text: string, modules: string[]): ModuleTurn => ({ runId: 'R-test', threadId: 'thr_w', text, user: { id: 'user:9229', name: 'Dana Lee', title: 'CEO' }, tenant: { name: 'Harborview' }, modules });
  const said = async (spec: ModuleSpec, t: ModuleTurn) => {
    const r = recorder();
    await runModuleOffline(spec, t, { gateway }, r.sink);
    return r.texts[0]!;
  };

  beforeAll(() => {
    pool = tenantPool(SCHEMA);
    queries = new QueryService(pool);
    calendar = new CalendarService({ onboarding: new OnboardingService(pool) as never, issues: new IssueService(pool) as never, retention: new RetentionService(pool) as never });
    const events = async (ctx: ModuleContext) => ({ today: '2026-10-25', items: await calendar.events({ canUse: () => true, ctx }) });
    cal = calendarModule(events);
    files = filesModule();
    gateway = new ModuleGateway(new ApprovalStore(pool), [cal, files]);
  });
  afterAll(() => pool.end());

  describe('queries', () => {
    it('runs a SELECT over curated tables and caps the rows', async () => {
      const r = await queries.run('SELECT loan_category, COUNT(*) AS n FROM cdm_loan GROUP BY loan_category');
      expect(r.tables).toEqual(['cdm_loan']);
      expect(r.columns).toEqual(['loan_category', 'n']);
      const many = await queries.run('SELECT loan_id FROM cdm_loan');
      expect(many.rows).toHaveLength(500);
      expect(many.truncated).toBe(true);
    });

    it.each([
      ['a write', 'UPDATE cdm_loan SET balance = 0'],
      ['a second statement', 'SELECT 1 AS a; DROP TABLE cdm_loan'],
      ['the AI ledger', 'SELECT question FROM ai_run'],
      ['users', 'SELECT name FROM iam_user'],
      ['a comma join', 'SELECT l.balance, u.name FROM cdm_loan l, iam_user u'],
      ['a subquery', 'SELECT a FROM (SELECT question AS a FROM ai_run) t'],
      ['contact details', 'SELECT party_id FROM cdm_party_contact'],
      ['birth dates', 'SELECT birth_date FROM cdm_party'],
      ['select star', 'SELECT * FROM cdm_party'],
      ['another institution', 'SELECT party_id FROM dinext_t_test_bank.cdm_party'],
      ['another institution, quoted', 'SELECT party_id FROM `dinext_t_test_bank`.`cdm_party`'],
      ['a table hidden by an escaped quote', "SELECT 'x\\'' AS a, name FROM iam_user WHERE 1 = '1'"],
      ['system tables', 'SELECT table_name FROM information_schema.tables'],
      ['writing a file', "SELECT 1 AS a INTO OUTFILE 'x'"],
      ['a comment', 'SELECT 1 AS a -- x'],
    ])('refuses %s', async (_name, sql) => {
      await expect(queries.run(sql)).rejects.toThrow();
    });
  });

  describe('calendar', () => {
    it('merges dated work in date order, and leaves out what a person can’t use', async () => {
      const all = await calendar.events({ canUse: () => true, ctx: {} });
      expect(new Set(all.map((e) => e.kind))).toEqual(new Set(['Touch point', 'Issue due', 'Certificates']));
      expect(all.map((e) => e.date)).toEqual([...all.map((e) => e.date)].sort());
      const none = await calendar.events({ canUse: (s) => s === 'onboarding', ctx: {} });
      expect(new Set(none.map((e) => e.kind))).toEqual(new Set(['Touch point']));
    });

    it('keeps to the purview', async () => {
      const west = await calendar.events({ canUse: (s) => s === 'compliance', ctx: { purviewBranches: ['Westport'] } });
      const all = await calendar.events({ canUse: (s) => s === 'compliance', ctx: {} });
      expect(west.length).toBeLessThan(all.length);
      expect(west.every((e) => e.detail.endsWith('Westport'))).toBe(true);
    });

    it('answers what’s due, and says it can’t schedule yet', async () => {
      expect(gateway.match('What’s due this week?')?.id).toBe('calendar');
      expect(await said(cal, turn('What’s due this week?', ['calendar']))).toMatch(/\d+ items?\*\* through/);
      expect(await said(cal, turn('Schedule a follow-up with Suzanne Jackson', ['calendar']))).toContain('can’t create');
      expect(await said(cal, turn('What’s due this week?', []))).toContain('isn’t part of your DI access');
    });
  });

  describe('files', () => {
    it('finds a document and names who can see a folder', async () => {
      expect(findFiles('dealer agreement for Smith Ford')[0]?.name).toContain('Smith Ford');
      expect(gateway.match('Find the dealer agreement for Smith Ford')?.id).toBe('files');
      expect(await said(files, turn('Find the dealer agreement for Smith Ford', ['files']))).toContain('found');
      expect(await said(files, turn('Who can see the Board Packs folder?', ['files']))).toContain('Board Packs');
      expect(await said(files, turn('Delete the board pack', ['files']))).toContain('can’t upload, move or delete');
    });
  });
});
