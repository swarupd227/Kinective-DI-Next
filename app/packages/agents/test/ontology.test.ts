// @vitest-environment node
// The data dictionary (Core Mapping and Ontology, phase 1) on the Data Lineage agent, against both
// seeded warehouses: a word in each institution's language, a DI column and a core column all reach
// the same concept, with its columns, measures, codes and Symitar columns. No model calls.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { validateBlock, type Block } from '@dinext/block-schemas';
import { ApprovalStore, LineageService, OntologyService } from '@dinext/di-core';
import { loadModel } from '@dinext/semantic';
import { tenantPool, warehouseAvailable, type Pool } from '@dinext/tenant-db';
import { lineageModule, ModuleGateway, ONTOLOGY_REQUEST, ontologyTerm, runModuleOffline, type ModuleSpec, type ModuleTurn, type RunSink } from '../src/index.ts';

const loaded = async (schema: string) => (await warehouseAvailable(schema)) && tenantPool(schema).query('SELECT 1 FROM onto_concept LIMIT 1').then(() => true, () => false);
const CU = 'dinext_t_test_cu';
const BANK = 'dinext_t_test_bank';
const up = (await loaded(CU)) && (await loaded(BANK));

function recorder() {
  const blocks: Block[] = [];
  const texts: string[] = [];
  const sink: RunSink = { signal: new AbortController().signal, routing: () => {}, plan: () => 'blk_plan00000000', step: () => {}, text: async (m) => void texts.push(m), block: async (b) => void blocks.push(b), suggestion: () => {} };
  return { sink, blocks, texts };
}

describe('data dictionary questions', () => {
  it('are recognized, and the word they are about is found', () => {
    const cases: [string, string][] = [
      ['What does DI mean by a share draft?', 'share draft'],
      ['Which column holds the loan balance?', 'loan balance'],
      ['Which Symitar column is the dividend rate?', 'dividend rate'],
      ['What do banks call a share certificate?', 'share certificate'],
      ['Look up DDA in the data dictionary', 'DDA'],
      ['How much does the data dictionary cover?', ''],
    ];
    for (const [q, term] of cases) {
      expect(ONTOLOGY_REQUEST.test(q), q).toBe(true);
      expect(ontologyTerm(q), q).toBe(term);
    }
    for (const q of ['Show loan growth by branch', 'How many members have a share draft?', 'What is our delinquency ratio?']) expect(ONTOLOGY_REQUEST.test(q), q).toBe(false);
  });
});

describe.skipIf(!up)('the data dictionary against the warehouse', () => {
  const pools: Pool[] = [];
  const make = (schema: string, type: 'credit_union' | 'bank') => {
    const pool = tenantPool(schema);
    pools.push(pool);
    const spec = lineageModule(new LineageService(pool, loadModel(type === 'bank' ? 'test_bank' : 'test_cu', type)), new OntologyService(pool, type));
    return { spec, svc: new OntologyService(pool, type), gateway: new ModuleGateway(new ApprovalStore(pool), [spec]) };
  };
  let cu: ReturnType<typeof make>;
  let bank: ReturnType<typeof make>;
  const turn = (text: string, threadId: string): ModuleTurn => ({ runId: `R-onto-${threadId}`, threadId, text, user: { id: 'user:9229', name: 'Dana Lee', title: 'CEO' }, tenant: { name: 'Harborview' }, modules: ['lineage'] });
  const ask = async (who: ReturnType<typeof make>, text: string, id: string) => {
    const r = recorder();
    await runModuleOffline(who.spec, turn(text, id), { gateway: who.gateway }, r.sink);
    for (const b of r.blocks) expect(validateBlock(b).ok, JSON.stringify(validateBlock(b))).toBe(true);
    return r;
  };

  beforeAll(() => {
    cu = make(CU, 'credit_union');
    bank = make(BANK, 'bank');
  });
  afterAll(async () => {
    for (const p of pools) await p.end();
  });

  it('routes data dictionary questions to Data Lineage', () => {
    for (const q of ['What does DI mean by a share draft?', 'Which Symitar column is the loan balance?', 'How much does the data dictionary cover?']) expect(cu.gateway.match(q)?.id, q).toBe('lineage');
  });

  it('finds one concept from a credit union word, a bank word, a DI column and a Symitar column', async () => {
    const [draft] = (await cu.svc.lookup('share draft'))!;
    expect(draft!.id).toBe('checking');
    expect(draft!.label).toBe('Share draft');
    const [dda] = (await bank.svc.lookup('DDA'))!;
    expect(dda!.id).toBe('checking');
    expect(dda!.label).toBe('Checking');
    const [col] = (await cu.svc.lookup('cdm_loan.balance'))!;
    expect(col!.id).toBe('loan.balance');
    const [core] = (await cu.svc.lookup('LOAN.BALANCE'))!;
    expect(core!.id).toBe('loan.balance');
    expect(core!.core[0]).toMatchObject({ system: 'Symitar', column: 'LOAN.BALANCE' });
    expect(core!.metrics.map((m) => m.name)).toContain('loan_balance');
    expect(core!.columns).toEqual(expect.arrayContaining(['cdm_loan.balance', 'hist_loan_month.balance']));
  });

  it('gives each code list the values both institutions hold', async () => {
    const [cat] = (await bank.svc.lookup('certificate of deposit'))!;
    expect(cat!.id).toBe('certificate');
    const set = await cu.svc.concept('deposit_category');
    const cert = set!.codes.find((c) => c.code === 'certificate')!;
    expect(cert.values).toEqual(expect.arrayContaining(['Certificates', 'Certificates of Deposit']));
    // Every share or deposit type and loan type in either warehouse is on a code list.
    for (const [who, schema] of [[cu, CU], [bank, BANK]] as const) {
      const [rows] = (await pools[who === cu ? 0 : 1]!.query(
        `SELECT DISTINCT d.deposit_category AS v, 'deposit_category' AS s FROM ${schema}.cdm_deposit_account d UNION SELECT DISTINCT l.loan_category, 'loan_category' FROM ${schema}.cdm_loan l`,
      )) as unknown as [{ v: string; s: string }[]];
      const [have] = (await pools[who === cu ? 0 : 1]!.query('SELECT value_set AS s, di_value AS v FROM onto_value')) as unknown as [{ v: string; s: string }[]];
      const known = new Set(have.map((h) => `${h.s}|${h.v}`));
      expect(rows.filter((r) => !known.has(`${r.s}|${r.v}`)).map((r) => `${r.s}: ${r.v}`), schema).toEqual([]);
    }
  });

  it('answers in the institution’s own words, with the columns, measures and Symitar column', async () => {
    const r = await ask(cu, 'What does DI mean by a share draft?', 'o1');
    expect(r.texts[0]).toContain('**Share draft**');
    expect(r.texts[0]).toMatch(/a kind of share/);
    const b = await ask(bank, 'Which column holds the loan balance?', 'o2');
    expect(b.texts[0]).toContain('**Balance** is a property of a loan');
    expect(b.texts[0]).toContain('`cdm_loan.balance`');
    expect(b.texts[0]).toContain('Total loan balance');
    expect(b.texts[0]).toContain('Symitar `LOAN.BALANCE`');
  });

  it('says what the data dictionary covers', async () => {
    const r = await ask(cu, 'How much does the data dictionary cover?', 'o3');
    expect(r.texts[0]).toMatch(/\*\*\d+ concepts\*\*/);
    expect(r.texts[0]).toContain('Symitar, 31 columns');
  });

  it('says plainly when a word isn’t in the dictionary', async () => {
    const r = await ask(cu, 'What does DI mean by a flux capacitor?', 'o4');
    expect(r.texts[0]).toContain('isn’t in DI’s data dictionary');
  });
});
