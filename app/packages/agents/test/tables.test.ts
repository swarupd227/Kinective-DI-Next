// @vitest-environment node
// The Tables agent: column stats, linked tables, snapshots, merged saved views, sharing, the Recycle
// Bin and restoring from it. Routing and the offline planner need no warehouse; the rest runs against
// the seeded one. No model calls.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ApprovalStore, TableService, keyNamed, shareTargetNamed, tableNamed } from '@dinext/di-core';
import { createPool, tenantPool, warehouseAvailable, type Pool } from '@dinext/tenant-db';
import { ModuleGateway, NO_TABLE_EDITS, calendarModule, filesModule, runModuleOffline, tablesModule, workflowBuilderModule, type ModuleContext, type ModuleOutcome, type ModuleSpec, type ModuleTurn, type RunSink } from '../src/index.ts';

const SCHEMA = 'dinext_t_test_cu';
const up = await warehouseAvailable(SCHEMA);
const TODAY = '2026-11-02';

const recorder = () => {
  const texts: string[] = [];
  const sink: RunSink = { signal: new AbortController().signal, routing: () => {}, plan: () => 'blk_plan00000000', step: () => {}, text: async (m) => void texts.push(m), block: async () => {}, suggestion: () => {} };
  return { sink, texts };
};

describe('routing to Tables', () => {
  // Tables comes first in the live list, so it must not take anyone else's requests.
  const gateway = new ModuleGateway(null as never, [tablesModule(null, () => TODAY), calendarModule(async () => ({ today: TODAY, items: [] }), null, async () => [], () => TODAY), filesModule(null, () => TODAY), workflowBuilderModule(null as never, () => TODAY)]);
  it.each([
    ['Profile the loan accounts table', 'tables'],
    ['Column stats for balance', 'tables'],
    ['Show column stats for the members table', 'tables'],
    ['Which tables link to loan accounts?', 'tables'],
    ['Snapshot the loan accounts table', 'tables'],
    ['Show my saved views and snapshots', 'tables'],
    ['Merge loan accounts with members on member ID as a saved view called Loans with members', 'tables'],
    ['Make the Loans with members view public to the Analyst class', 'tables'],
    ['Delete the Loans with members view', 'tables'],
    ['Restore the Loans with members view from the Recycle Bin', 'tables'],
    ['What’s in the Tables Recycle Bin?', 'tables'],
    ['Add a new record to the loan accounts table', 'tables'],
    ['Edit the balance in the loan accounts table', 'tables'],
    ['Restore Westport huddle notes.txt', 'files'],
    ['What’s in my Recycle Bin?', 'files'],
    ['Delete Westport huddle notes.txt', 'files'],
    ['Schedule a team huddle every Monday at 9 am', 'calendar'],
    ['Cancel just next Monday’s huddle', 'calendar'],
    ['Cancel the whole team huddle series', 'calendar'],
    ['Build a table summary of fees by product', undefined],
    ['Send me the branch scorecard every Monday', undefined],
    ['Send this report to me every Monday at 8 am', undefined],
    ['Schedule it every Monday at 8 am', undefined],
    ['Save this report in the Finance / ALCO folder', undefined],
    ['Show total loan balance by branch', undefined],
    ['Show the early-warning list', undefined],
    ['Create a task for Ana Ruiz to call the Jacksons about the HELOC', undefined],
    ['Change the note to say she prefers email', undefined],
    ['Move Acme Manufacturing to Pre-Qualified', undefined],
    ['Which workflows do we have?', 'workflow-builder'],
  ])('%s', (q, id) => {
    expect(gateway.match(q)?.id).toBe(id);
  });
});

describe('the Tables planner', () => {
  const spec = tablesModule(new TableService(null as never), () => TODAY);
  const ctx = {} as ModuleContext;
  it.each([
    ['Profile the loan accounts table', { tool: 'tbl_stats', args: { table: 'loan_accounts' } }],
    ['Column stats for balance', { tool: 'tbl_stats', args: { table: 'loan_accounts', column: 'Balance' } }],
    ['Column stats for the region column in branches', { tool: 'tbl_stats', args: { table: 'branches', column: 'Region' } }],
    ['Which tables link to loan accounts?', { tool: 'tbl_relationships', args: { table: 'loan_accounts' } }],
    ['Snapshot the loan accounts table', { tool: 'tbl_snapshot', args: { table: 'loan accounts' } }],
    ['Show my saved views and snapshots', { tool: 'tbl_list', args: {} }],
    ['Merge loan accounts with members on member ID as a saved view called Loans with members', { tool: 'tbl_merge', args: { left: 'loan accounts', right: 'members', key: 'member ID', name: 'Loans with members' } }],
    ['Merge deposit accounts with branches on branch', { tool: 'tbl_merge', args: { left: 'deposit accounts', right: 'branches', key: 'branch' } }],
    ['Make the Loans with members view public to the Analyst class', { tool: 'tbl_share', args: { item: 'Loans with members', with: 'Analyst' } }],
    ['Make the Loans with members view public', { tool: 'tbl_share', args: { item: 'Loans with members' } }],
    ['Share Loan Accounts snapshot 2026-11-02 with everyone', { tool: 'tbl_share', args: { item: 'Loan Accounts snapshot 2026-11-02', with: 'everyone' } }],
    ['Delete the Loans with members view', { tool: 'tbl_delete', args: { item: 'Loans with members' } }],
    ['Restore the Loans with members view from the Recycle Bin', { tool: 'tbl_restore', args: { item: 'Loans with members' } }],
    ['What’s in the Tables Recycle Bin?', { tool: 'tbl_bin', args: {} }],
    ['Add a new record to the loan accounts table', { say: NO_TABLE_EDITS }],
  ])('%s', (q, plan) => {
    expect(spec.plan(q, ctx)).toEqual(plan);
  });

  it('names tables, keys and classes in plain words', () => {
    expect(tableNamed('the loans table')?.id).toBe('loan_accounts');
    expect(tableNamed('Certificates')?.id).toBe('certificates');
    expect(tableNamed('customers')?.id).toBe('members');
    expect(keyNamed('member ID')).toBe('member_id');
    expect(keyNamed('Customer id')).toBe('member_id');
    expect(shareTargetNamed('the analyst class')).toBe('Analyst');
    expect(shareTargetNamed('managers')).toBe('Manager');
    expect(shareTargetNamed('everyone')).toBe('Everyone');
    expect(shareTargetNamed('the board')).toBeUndefined();
  });
});

describe.skipIf(!up)('Tables against the warehouse', () => {
  let pool: Pool;
  let admin: Pool;
  let svc: TableService;
  let gateway: ModuleGateway;
  let tbl: ModuleSpec;
  const me = { id: 'user:tbltest1', name: 'Tab Tester' };
  const priya = { id: 'user:4410', name: 'Priya Shah' };
  const marcus = { id: 'user:5120', name: 'Marcus Reed' };
  const turn = (text: string, modules: string[] = ['tables'], user = me, purviewBranches?: string[]): ModuleTurn => ({ runId: 'R-test', threadId: `thr_${Math.random().toString(36).slice(2, 10)}`, text, user: { ...user, title: 'Tester' }, tenant: { name: 'Harborview' }, modules, ...(purviewBranches ? { purviewBranches } : {}) });
  const run = async (t: ModuleTurn) => {
    const r = recorder();
    const out = await runModuleOffline(tbl, t, { gateway }, r.sink);
    return { text: r.texts[0]!, out, t };
  };
  const said = async (t: ModuleTurn) => (await run(t)).text;
  const ctxOf = (t: ModuleTurn): ModuleContext => ({ user: t.user, modules: t.modules, runId: t.runId, threadId: t.threadId, purviewBranches: t.purviewBranches });
  const approve = async (o: { out: ModuleOutcome; t: ModuleTurn }) => {
    const a = await new ApprovalStore(pool).decide(o.out.approval!.record.approvalId, { decision: 'approved', userId: o.t.user.id, payloadHash: o.out.approval!.record.payloadHash });
    return gateway.execute(a, ctxOf(o.t));
  };
  const applyAgain = async (o: { out: ModuleOutcome; t: ModuleTurn }) => {
    const payload = o.out.approval!.record.payload as { tool: string; apply: unknown };
    await tbl.tools.find((x) => x.name === payload.tool)!.apply!(payload.apply as never, { approvalId: o.out.approval!.record.approvalId, userId: o.t.user.id }, ctxOf(o.t));
  };
  const mine = async (status: 'Active' | 'Recycle Bin' = 'Active') => (await svc.objects(me.id, { status })).filter((o) => o.ownerUserId === me.id);
  const cleanUp = async () => {
    await admin.query("DELETE FROM tbl_object WHERE owner_user_id LIKE 'user:tbltest%'");
    await admin.query("DELETE FROM ai_approvals WHERE requested_by LIKE 'user:tbltest%'");
  };

  beforeAll(async () => {
    pool = tenantPool(SCHEMA);
    admin = createPool(`${process.env.DI_DB_ADMIN_URL ?? 'mysql://root:dinext_local_root@127.0.0.1:3307'}/${SCHEMA}`);
    await cleanUp();
    svc = new TableService(pool);
    tbl = tablesModule(svc, () => TODAY);
    gateway = new ModuleGateway(new ApprovalStore(pool), [tbl]);
  });
  afterAll(async () => {
    await cleanUp();
    await admin.end();
    await pool.end();
  });

  it('profiles a table within the purview, and leaves personal columns out', async () => {
    const all = await svc.stats('loan_accounts', {});
    const west = await svc.stats('loan_accounts', { purviewBranches: ['Westport'] });
    expect(west.rows).toBeLessThan(all.rows);
    const balance = all.columns.find((c) => c.column === 'Balance')!;
    expect(balance).toMatchObject({ type: 'currency', nonNullPct: 100 });
    expect(Number(balance.min)).toBeLessThanOrEqual(Number(balance.mean));
    expect(Number(balance.mean)).toBeLessThanOrEqual(Number(balance.max));
    expect(west.columns.find((c) => c.column === 'Branch')!.top).toEqual([{ value: 'Westport', count: west.rows }]);
    expect(all.columns.find((c) => c.column === 'Product')!.top.length).toBeGreaterThan(0);
    const members = await svc.stats('members', {});
    expect(members.columns.map((c) => c.field)).not.toEqual(expect.arrayContaining(['birth_date']));
    expect(await said(turn('Profile the members table'))).toContain('Personal columns (name, birth date, household) are left out');
    expect(await said(turn('Column stats for the birth date column in members'))).toContain('personal data');
    expect(await said(turn('Column stats for balance'))).toMatch(/^\*\*Balance\*\* in Loan Accounts: 100% filled/);
    expect(await said(turn('Profile the loan accounts table', []))).toContain('isn’t part of your DI access');
  });

  it('names the tables that link to one, and on what', async () => {
    expect(svc.relationships('loan_accounts')).toEqual([{ table: 'Members', tableId: 'members', key: 'Member ID', shape: 'Many to one' }, { table: 'Branches', tableId: 'branches', key: 'Branch', shape: 'Many to one' }]);
    expect(await said(turn('Which tables link to loan accounts?'))).toContain('Members on Member ID');
  });

  it('snapshots a table at low risk, once, frozen and capped', async () => {
    const o = await run(turn('Snapshot the loan accounts table'));
    expect(o.out.approval?.record.riskTier).toBe('low');
    expect(o.text).toContain('Snapshots keep up to 5,000 rows');
    expect(await mine()).toEqual([]);
    await approve(o);
    await applyAgain(o);
    const snaps = await mine();
    expect(snaps).toEqual([expect.objectContaining({ kind: 'Snapshot', name: `Loan Accounts snapshot ${TODAY}`, rowCount: 5000, sharedClass: null })]);
    const rows = await svc.objectRows(me.id, snaps[0]!.objId, {});
    expect(rows!.rows).toHaveLength(500);
    expect(rows!.columns.map((c) => c.headerName)).toContain('Balance');
    expect(await said(turn('Snapshot the loan accounts table'))).toContain('already took');
  });

  it('saves a merged view at low risk: the definition, not a copy, and only valid keys', async () => {
    expect(await said(turn('Merge loan accounts with branches on member ID as a saved view called Nope'))).toBe('I can’t merge on Member ID: Branches has no such column. Loan Accounts and Branches share Branch.');
    const ask = await run(turn('Merge loan accounts with members on member ID'));
    expect(ask.out.asked).toBe(true);
    expect(ask.text).toContain('What should the saved view');
    expect(await said(turn('Merge loan accounts with loan accounts on member ID as a saved view called Twice'))).toContain('two different tables');
    const o = await run(turn('Merge loan accounts with members on member ID as a saved view called Tabtest loans with members'));
    expect(o.out.approval?.record.riskTier).toBe('low');
    const changes = (o.out.approval!.record.payload as { changes: { label: string; after: string }[] }).changes;
    expect(changes.find((c) => c.label === 'Merges')?.after).toBe('Loan Accounts with Members on Member ID');
    await approve(o);
    await applyAgain(o);
    const view = (await mine()).filter((x) => x.kind === 'View');
    expect(view).toEqual([expect.objectContaining({ name: 'Tabtest loans with members', definition: { left: 'loan_accounts', right: 'members', key: 'member_id' } })]);
    const [[raw]] = (await admin.query('SELECT content FROM tbl_object WHERE obj_id = ?', [view[0]!.objId])) as unknown as [[{ content: string | null }]];
    expect(raw.content).toBeNull();
    const rows = await svc.objectRows(me.id, view[0]!.objId, { purviewBranches: ['Westport'] });
    expect(rows!.columns.map((c) => c.headerName)).toEqual(expect.arrayContaining(['Balance', 'Joined', 'Segment', 'Members: Branch']));
    expect(rows!.rows.every((r) => r.branch === 'Westport')).toBe(true);
    expect(await said(turn('Merge loan accounts with members on member ID as a saved view called Tabtest loans with members'))).toContain('already have');
  });

  it('shares at medium risk with a class, and each person sees only their purview', async () => {
    expect(await said(turn('Make the Tabtest loans with members view public'))).toContain('with which class');
    const o = await run(turn('Make the Tabtest loans with members view public to the Analyst class'));
    expect(o.out.approval?.record.riskTier).toBe('medium');
    expect(await svc.objects(priya.id)).not.toEqual(expect.arrayContaining([expect.objectContaining({ name: 'Tabtest loans with members' })]));
    await approve(o);
    await applyAgain(o);
    expect(await svc.objects(priya.id)).toEqual(expect.arrayContaining([expect.objectContaining({ name: 'Tabtest loans with members', sharedClass: 'Analyst' })]));
    expect((await svc.objects(marcus.id)).some((x) => x.name === 'Tabtest loans with members')).toBe(false);
    // Shared isn't owned: Priya can open it but not change it.
    expect(await said(turn('Delete the Tabtest loans with members view', ['tables'], priya))).toContain('is Tab Tester’s, so I can’t change it');
    const snap = await run(turn(`Share Loan Accounts snapshot ${TODAY} with managers`));
    expect(snap.out.approval?.record.riskTier).toBe('medium');
    await approve(snap);
    const shared = (await svc.objects(marcus.id)).find((x) => x.kind === 'Snapshot' && x.ownerUserId === me.id)!;
    const west = await svc.objectRows(marcus.id, shared.objId, { purviewBranches: ['Westport'] });
    expect(west!.rowCount).toBeGreaterThan(0);
    expect(west!.rowCount).toBeLessThan(5000);
    expect(west!.rows.every((r) => r.branch === 'Westport')).toBe(true);
    expect(await svc.objectRows('user:6101', shared.objId, {})).toBeNull();
  });

  it('deletes to the Recycle Bin and restores from it at low risk, never for good', async () => {
    const o = await run(turn('Delete the Tabtest loans with members view'));
    expect(o.out.approval?.record.riskTier).toBe('low');
    expect(o.text).toContain('isn’t deleted for good');
    await approve(o);
    await applyAgain(o);
    expect((await mine()).some((x) => x.name === 'Tabtest loans with members')).toBe(false);
    expect((await svc.objects(priya.id)).some((x) => x.name === 'Tabtest loans with members')).toBe(false);
    expect(await mine('Recycle Bin')).toEqual([expect.objectContaining({ name: 'Tabtest loans with members', status: 'Recycle Bin', recycledOn: TODAY })]);
    expect(await said(turn('What’s in the Tables Recycle Bin?'))).toContain('**1 item**');
    // Priya can't see someone else's Recycle Bin.
    expect(await said(turn('Restore Tabtest loans with members', ['tables'], priya))).toContain('nothing called');
    const r = await run(turn('Restore the Tabtest loans with members view from the Recycle Bin'));
    expect(r.out.approval?.record.riskTier).toBe('low');
    await approve(r);
    await applyAgain(r);
    expect((await mine()).find((x) => x.name === 'Tabtest loans with members')).toMatchObject({ status: 'Active', sharedClass: 'Analyst' });
    expect(await said(turn('Restore Tabtest loans with members'))).toContain('isn’t in the Recycle Bin');
  });

  it('won’t edit warehouse rows, and someone else’s private view reads as not found', async () => {
    const edit = await run(turn('Add a new record to the loan accounts table'));
    expect(edit.text).toBe(NO_TABLE_EDITS);
    expect(edit.out.approval).toBeUndefined();
    const other = await said(turn('Delete the Loans with member details view', ['tables'], { id: 'user:9229', name: 'Dana Lee' }));
    expect(other).toContain('no saved view or snapshot called');
    expect(other).not.toContain('Priya');
  });
});
