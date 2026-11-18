// @vitest-environment node
// Ontology across agents (Core Mapping and Ontology, phase 5): the concepts a question names, what they
// add to Analytics Q&A's catalog search, the tags routing sees, and impact by concept or core column on
// Data Lineage. No model calls.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { validateBlock, type Block } from '@dinext/block-schemas';
import { ApprovalStore, LineageService, OntologyService } from '@dinext/di-core';
import { conceptsIn, ontology } from '@dinext/ontology';
import { loadModel, searchCatalog } from '@dinext/semantic';
import { tenantPool, warehouseAvailable, type Pool } from '@dinext/tenant-db';
import { lineageModule, ModuleGateway, runModuleOffline, type ModuleTurn, type RunSink } from '../src/index.ts';
import { CONCEPT_IMPACT, impactSubject } from '../src/governance.ts';
import { conceptLine, conceptTags, readConcepts } from '../src/concepts.ts';

const DIMS = {
  branch: ['Westport', 'Northgate'],
  loan_category: ['Auto', 'Business', 'Credit Card', 'HELOC', 'Mortgage', 'Personal'],
  deposit_category: ['Certificates', 'Checking', 'IRA', 'Money Market', 'Share Savings'],
  origination_channel: ['Direct', 'Indirect'],
  member_segment: ['Retail', 'Young Adult', 'Senior', 'Small Business'],
};
const read = (q: string, type: 'credit_union' | 'bank' = 'credit_union') => conceptsIn(ontology(), q, type, DIMS).map((c) => `${c.said}=${c.value ?? c.id}`);

describe('concepts in a question', () => {
  it('reads codes by their everyday names and abbreviations, as the value DI holds', () => {
    expect(read('How much is in DDA accounts?')).toEqual(['DDA=Checking']);
    expect(read('What do we have in share drafts?')).toEqual(['share drafts=Checking']);
    expect(read('How much is in CDs?', 'bank')).toEqual(['CDs=Certificates']);
    expect(read('How much do we have in first mortgages?')).toEqual(['first mortgages=Mortgage']);
    expect(read('Balance of signature loans')).toContain('signature loans=Personal');
    expect(read('How many young adults are members?')).toEqual(['young adults=Young Adult', 'members=member']);
  });

  it('takes the longest phrase from the left, so a car loan isn’t a loan balance', () => {
    expect(read('Car loan balances')).toEqual(['Car loan=Auto', 'balances=loan.balance']);
    expect(read('Home equity line balances')).toEqual(['Home equity line=HELOC', 'balances=loan.balance']);
  });

  it('settles a word with two meanings from the rest of the question, or leaves it out', () => {
    expect(read('Visa card balances')).toEqual(['Visa=Credit Card', 'balances=loan.balance']);
    expect(read('Share draft balances by branch')).toContain('balances=deposit.balance');
    expect(read('Show balances by branch')).not.toContain('balances=loan.balance');
    expect(read('Show balances by branch')).not.toContain('balances=deposit.balance');
  });

  it('uses each institution’s own words: owners are members at a credit union, not at a bank', () => {
    expect(read('How many owners do we have?')).toEqual(['owners=member']);
    expect(read('How many owners do we have?', 'bank')).toEqual([]);
    expect(read('How many customers do we have?', 'bank')).toEqual(['customers=member']);
  });

  it('says how it read the words that differ from DI’s own, and tags the classes for routing', () => {
    const { concepts } = readConcepts('Car loan and DDA balances past due', 'credit_union', DIMS);
    expect(conceptLine(concepts)).toBe('“Car loan” as Auto, “DDA” as Checking, “past due” as days past due');
    expect(conceptTags(concepts)).toEqual(['loan', 'deposit']);
  });
});

describe('Analytics Q&A’s catalog search with the ontology’s hints', () => {
  const models = { credit_union: loadModel('test_cu', 'credit_union'), bank: loadModel('test_bank', 'bank') };
  const search = (q: string, type: 'credit_union' | 'bank' = 'credit_union') => searchCatalog(models[type], q, DIMS, readConcepts(q, type, DIMS).hints);

  it('answers questions it refused before, with the value to filter by', () => {
    const cases: [string, 'credit_union' | 'bank', string, string | null][] = [
      ['How much is in DDA accounts?', 'credit_union', 'deposit_account_count', 'Checking'],
      ['How much is in DDA accounts?', 'bank', 'deposit_account_count', 'Checking'],
      ['What do we have in share drafts?', 'credit_union', 'checking_penetration', 'Checking'],
      ['How much is in CDs?', 'credit_union', 'deposit_balance', 'Certificates'],
      ['How much is in CDs?', 'bank', 'deposit_balance', 'Certificates'],
      ['How much do we have in first mortgages?', 'credit_union', 'loan_balance', 'Mortgage'],
      ['How many owners do we have?', 'credit_union', 'member_count', null],
    ];
    for (const [q, type, metric, value] of cases) {
      expect(searchCatalog(models[type], q, DIMS).matched, `${type}: ${q} was refused before`).toBe(false);
      const r = search(q, type);
      expect(r.matched, `${type}: ${q}`).toBe(true);
      expect(r.metrics.map((m) => m.name), `${type}: ${q}`).toContain(metric);
      if (value) expect(r.values.map((v) => v.value), `${type}: ${q}`).toContain(value);
      expect(r.unknownTerms, `${type}: ${q}`).toEqual([]);
    }
  });

  it('adds the filter a plain search missed, and favors the metric a named property is read by', () => {
    for (const [q, value] of [['Car loan balances', 'Auto'], ['Unsecured loan balances', 'Personal'], ['Visa card balances', 'Credit Card'], ['Balance of signature loans', 'Personal']]) {
      expect(searchCatalog(models.credit_union, q!, DIMS).values.map((v) => v.value), q).not.toContain(value);
      expect(search(q!).values.map((v) => v.value), q).toContain(value);
    }
    expect(searchCatalog(models.credit_union, 'How many loans are past due?', DIMS).metrics[0]!.name).toBe('loan_balance');
    expect(search('How many loans are past due?').metrics[0]!.name).toBe('delinquency_ratio_60_plus');
  });

  it('still refuses what nothing defines, and leaves questions it already answered as they were', () => {
    expect(search('Total dividends paid').matched).toBe(false);
    expect(search("What's our wallet share with gig workers?").matched).toBe(false);
    for (const q of ['Show loan growth by branch for Q3 vs Q2', 'What is our net worth ratio?', 'How many members joined last quarter?', 'What is our weighted average loan rate by loan type?', 'certificates maturing in the next 90 days']) {
      expect(search(q).metrics[0]!.name, q).toBe(searchCatalog(models.credit_union, q, DIMS).metrics[0]!.name);
    }
  });
});

describe('impact questions by concept or core column', () => {
  it('are recognized, with what they are about', () => {
    const cases: [string, string][] = [
      ['What changes if the core changes how it codes loan type?', 'loan type'],
      ['What breaks if LOAN.TYPE changes?', 'LOAN.TYPE'],
      ['What is affected if Symitar adds a new share type code?', 'share type'],
      ['What would change if the core renamed the loan balance column?', 'loan balance'],
    ];
    for (const [q, subject] of cases) {
      expect(CONCEPT_IMPACT.test(q), q).toBe(true);
      expect(impactSubject(q), q).toBe(subject);
    }
    for (const q of ['What changes if rates rise 100 basis points?', 'What changed in the core?', 'Show loan growth by branch']) expect(CONCEPT_IMPACT.test(q), q).toBe(false);
  });
});

const loaded = async (schema: string) => (await warehouseAvailable(schema)) && tenantPool(schema).query('SELECT 1 FROM onto_concept LIMIT 1').then(() => true, () => false);
const CU = 'dinext_t_test_cu';
const up = await loaded(CU);

describe.skipIf(!up)('impact by concept against the warehouse', () => {
  let pool: Pool;
  let spec: ReturnType<typeof lineageModule>;
  let gateway: ModuleGateway;
  beforeAll(() => {
    pool = tenantPool(CU);
    spec = lineageModule(new LineageService(pool, loadModel('test_cu', 'credit_union')), new OntologyService(pool, 'credit_union'));
    gateway = new ModuleGateway(new ApprovalStore(pool), [spec]);
  });
  afterAll(async () => {
    await pool.end();
  });
  const ask = async (text: string, id: string) => {
    const blocks: Block[] = [];
    const texts: string[] = [];
    const tools: string[] = [];
    const sink: RunSink = { signal: new AbortController().signal, routing: () => {}, plan: () => 'blk_plan00000000', step: (_p, s) => void (s.operation && tools.push(s.operation)), text: async (m) => void texts.push(m), block: async (b) => void blocks.push(b), suggestion: () => {} };
    const turn: ModuleTurn = { runId: `R-impact-${id}`, threadId: id, text, user: { id: 'user:9229', name: 'Dana Lee', title: 'CEO' }, tenant: { name: 'Harborview' }, modules: ['lineage'] };
    expect(spec.request.test(text), text).toBe(true);
    await runModuleOffline(spec, turn, { gateway }, sink);
    for (const b of blocks) expect(validateBlock(b).ok, JSON.stringify(validateBlock(b))).toBe(true);
    return { text: texts.join('\n'), blocks };
  };

  it('follows a concept to the DI columns that hold it, then to the measures and reports that read them', async () => {
    const r = await ask('What changes if the core changes how it codes loan type?', 'imp-1');
    expect(r.text).toMatch(/^\*\*Loan type\*\* \(from Symitar LOAN\.TYPE\) is held in \d+ DI columns\. A change to it moves \*\*\d+ measures?\*\* and \*\*\d+ reports?\*\*, through the loan category breakdown\./);
    expect(r.text).toContain('A code the mapping doesn’t know is held on the next pull');
    const table = r.blocks.find((b) => b.type === 'table') as Extract<Block, { type: 'table' }>;
    const rows = table.data.rows as { kind: string; name: string; through: string }[];
    expect(rows.some((x) => x.kind === 'Measure' && x.through.includes('loan_category'))).toBe(true);
  });

  it('reaches the same concept from the core column', async () => {
    const byWords = await ask('What changes if the core changes how it codes loan type?', 'imp-2');
    const byColumn = await ask('What breaks if LOAN.TYPE changes?', 'imp-3');
    expect(byColumn.text).toBe(byWords.text);
  });

  it('says so when the words name no field DI holds', async () => {
    const r = await ask('What changes if the core changes the wallet code?', 'imp-4');
    expect(r.text).toMatch(/isn’t in DI’s data dictionary|not a field DI holds/);
  });
});
