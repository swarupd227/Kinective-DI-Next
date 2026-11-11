// @vitest-environment node
// Decision tables: DMN cells and hit policies read as a business user writes them; a case run through a
// table says which rules matched and why; a table applied to today's data says what it decides; and a
// change is checked, shows who or what it moves, and takes effect only when someone else approves it.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { validateBlock, type Block } from '@dinext/block-schemas';
import { ApprovalStore, DecisionTableService, compileTable, parseCell, validateTable } from '@dinext/di-core';
import { createPool, defaultDecisionTables, tenantPool, warehouseAvailable, type Pool } from '@dinext/tenant-db';
import { DECISION_RULES_REQUEST, ModuleGateway, caseIn, decisionRulesModule, editsIn, runModuleOffline, tableIn, type ModuleSpec, type ModuleTurn, type RunSink } from '../src/index.ts';

describe('DMN cells and hit policies', () => {
  const num = { key: 'x', label: 'Score', type: 'number' as const };
  it('reads comparisons, ranges, lists, not() and yes/no', () => {
    expect(parseCell('-', num)(5)).toBe(true);
    expect(parseCell('< 640', num)(639)).toBe(true);
    expect(parseCell('< 640', num)(640)).toBe(false);
    expect(parseCell('[640..700)', num)(640)).toBe(true);
    expect(parseCell('[640..700)', num)(700)).toBe(false);
    expect(parseCell('>= 50,000', num)(50000)).toBe(true);
    expect(parseCell('< 640', num)(null)).toBe(false);
    const band = { key: 'b', label: 'Band', type: 'text' as const };
    expect(parseCell('High, Medium', band)('medium')).toBe(true);
    expect(parseCell('not(Low)', band)('Low')).toBe(false);
    expect(parseCell('yes', { key: 'd', label: 'DD', type: 'boolean' })(true)).toBe(true);
    expect(() => parseCell('about 600', num)).toThrow(/isn’t a condition/);
  });
  it('decides by hit policy, and says what is wrong with a bad cell', () => {
    const [retention, pricing] = defaultDecisionTables('credit_union');
    const first = compileTable(retention!)({ band: 'High', deposits: 60000, products: 3, years: 2 });
    expect(first.matched).toEqual([1]);
    expect(first.outputs[0]!.action).toBe('Branch manager call');
    const sum = compileTable(pricing!)({ score: 690, ltv: 105, term: 84, direct_deposit: true });
    expect(sum.matched).toEqual([3, 5, 6, 7]);
    expect(sum.total).toBe(100 + 75 + 50 - 25);
    const unique = compileTable({ ...pricing!, hitPolicy: 'UNIQUE', aggregation: undefined })({ score: 690, ltv: 105, term: 12, direct_deposit: false });
    expect(unique.conflict).toBe(true);
    expect(validateTable({ ...retention!, rules: [{ when: { band: 'High', deposits: 'lots' }, then: { action: 'Call', owner: 'X', within: 'soon' } }] })).toEqual(['Rule 1: “lots” isn’t a condition DI reads, for Deposits ($): use a number, < 640, >= 50000, [640..700) or -.', 'Rule 1: Within (days) “soon” isn’t a number.']);
  });
  it('reads tables, edits and cases from plain words', () => {
    expect(tableIn('Show the pricing table')).toBe('loan_pricing');
    expect(tableIn('What does the retention table decide?')).toBe('retention_action');
    expect(editsIn('Set rule 1’s within to 3 days in the retention table')).toEqual([{ rule: 1, set: { within: '3' } }]);
    expect(editsIn('remove rule 6 of the pricing table')).toEqual([{ rule: 6, remove: true }]);
    expect(caseIn('loan_pricing', 'What adjustment does a 690 score, 95% LTV, 72-month loan get?')).toEqual({ score: 690, ltv: 95, term: 72, direct_deposit: false });
    for (const q of ['Show the decision tables', 'Show the pricing table', 'Set rule 1’s deposits to >= 25000 in the retention table', 'What adjustment does a 690 score, 95% LTV, 72-month loan get?']) expect(DECISION_RULES_REQUEST.test(q), q).toBe(true);
    for (const q of ['Run the stress test', 'How should we price our deposits?', 'What is our loan pricing?']) expect(DECISION_RULES_REQUEST.test(q), q).toBe(false);
  });
});

const SCHEMA = 'dinext_t_test_bank';
const up = await warehouseAvailable(SCHEMA).then((ok) => ok && tenantPool(SCHEMA).query('SELECT 1 FROM dmn_table_version LIMIT 1').then(() => true, () => false));

describe.skipIf(!up)('decision tables against the bank warehouse', () => {
  let pool: Pool;
  let admin: Pool;
  let spec: ModuleSpec;
  let gateway: ModuleGateway;
  const PRIYA = { id: 'user:4410', name: 'Priya Shah', title: 'BI Manager' };
  const ELENA = { id: 'user:7001', name: 'Elena Ortiz', title: 'Chief Financial Officer' };
  const turn = (text: string, user = PRIYA, modules = ['profitability', 'predictive']): ModuleTurn => ({ runId: 'R-dmn', threadId: `thr_${Math.random().toString(36).slice(2, 10)}`, text, user, tenant: { name: 'Coastal Community Bank' }, modules });
  const run = async (t: ModuleTurn) => {
    const texts: string[] = [];
    const blocks: Block[] = [];
    const sink: RunSink = { signal: new AbortController().signal, routing: () => {}, plan: () => 'blk_plan00000000', step: () => {}, text: async (m) => void texts.push(m), block: async (b) => void blocks.push(b), suggestion: () => {} };
    const out = await runModuleOffline(spec, t, { gateway }, sink);
    return { text: texts.join(' '), blocks, out, t };
  };
  const approve = async (o: Awaited<ReturnType<typeof run>>, by: { id: string; name: string; title: string }) => {
    const a = await new ApprovalStore(pool).decide(o.out.approval!.record.approvalId, { decision: 'approved', userId: by.id, payloadHash: o.out.approval!.record.payloadHash });
    return gateway.execute(a, { user: by, modules: o.t.modules, runId: o.t.runId, threadId: o.t.threadId });
  };
  // Back to the tables DI starts with.
  const reset = async () => {
    await admin.query('DELETE FROM dmn_table_version WHERE version > 1');
    await admin.query("UPDATE dmn_table_version SET status = 'Active' WHERE version = 1");
  };

  beforeAll(async () => {
    pool = tenantPool(SCHEMA);
    admin = createPool(`${process.env.DI_DB_ADMIN_URL ?? 'mysql://root:dinext_local_root@127.0.0.1:3307'}/${SCHEMA}`);
    spec = decisionRulesModule(new DecisionTableService(pool, 'bank'));
    gateway = new ModuleGateway(new ApprovalStore(pool), [spec]);
    await reset();
  });
  afterAll(async () => {
    await reset();
    await Promise.all([pool.end(), admin.end()]);
  });

  it('shows a table, tries a case and applies it to today’s loans', async () => {
    const list = await run(turn('Show the decision tables'));
    expect(list.text).toMatch(/Consumer loan pricing adjustments/);
    const show = await run(turn('Show the pricing table'));
    expect(show.blocks[0]!.type).toBe('table');
    const tried = await run(turn('What adjustment does a 690 score, 95% LTV, 72-month loan get?'));
    expect(tried.text).toMatch(/\*\*\+100 bp\*\*, from rule 3 \(Tier C credit\)/);
    const applied = await run(turn('What does the pricing table decide today?'));
    expect(applied.text).toMatch(/consumer loans opened in the last 90 days/);
    expect(applied.text).toMatch(/would need a pricing exception/);
    for (const b of [...list.blocks, ...show.blocks, ...tried.blocks, ...applied.blocks]) expect(validateBlock(b).ok).toBe(true);
    // Only the tables a person's access covers.
    const lender = await run(turn('Show the decision tables', PRIYA, ['profitability']));
    expect(lender.text).not.toMatch(/Retention outreach/);
  }, 60_000);

  it('changes a rule only when someone else approves it, and keeps every version', async () => {
    const bad = await run(turn('Set rule 4’s credit score to below six forty in the pricing table'));
    expect(bad.text).toMatch(/can’t go in as written/);
    expect(bad.out.approval).toBeUndefined();
    const change = await run(turn('Set rule 4’s adjustment to 300 bp in the pricing table'));
    expect(change.out.approval?.record.riskTier).toBe('medium');
    expect(validateBlock(change.out.approval!.card).ok).toBe(true);
    expect(change.text).toMatch(/moves \*\*\d+\*\*: \d+ from \+250 bp to \+300 bp/);
    await expect(approve(change, PRIYA)).rejects.toThrow();
    await approve(change, ELENA);
    const svc = new DecisionTableService(pool, 'bank');
    const now = (await svc.get('loan_pricing'))!;
    expect(now.version).toBe(2);
    expect(now.rules[3]!.then.adjustment).toBe('300');
    expect(now).toMatchObject({ changedBy: 'Priya Shah', approvedBy: 'Elena Ortiz' });
    const history = await run(turn('Who changed the pricing table?'));
    expect(history.text).toMatch(/2 versions; version 2 is in use/);
  }, 60_000);
});
