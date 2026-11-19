// @vitest-environment node
// An institution's own words (Core Mapping and Ontology, phase 11), at the bank: DI lists the
// questions it couldn't read and what each unread word might mean, a person approves "owners" for
// customers, and then "How many owners do we have?" is answered. No model calls.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { validateBlock, type Block } from '@dinext/block-schemas';
import { ApprovalStore, LineageService, OntologyService } from '@dinext/di-core';
import { SemanticService, WordStore } from '@dinext/semantic';
import { createPool, tenantPool, warehouseAvailable, type Pool } from '@dinext/tenant-db';
import { lineageModule, ModuleGateway, runModuleOffline, runOffline, type ModuleSpec, type ModuleTurn, type RunSink } from '../src/index.ts';
import { ADD_WORD, wordsPlan } from '../src/words.ts';

describe('reading words requests', () => {
  it('finds the word and its meaning', () => {
    expect(wordsPlan('Which questions couldn’t DI read?')).toEqual({ tool: 'onto_unread', args: {} });
    expect(wordsPlan('What words doesn’t DI understand?')).toEqual({ tool: 'onto_unread', args: {} });
    expect(wordsPlan('Treat “owners” as customers')).toEqual({ tool: 'onto_word_add', args: { term: 'owners', meaning: 'customers' } });
    expect(wordsPlan('"brnch" means branch')).toEqual({ tool: 'onto_word_add', args: { term: 'brnch', meaning: 'branch' } });
    expect(wordsPlan('Add owners as a word for our customers')).toEqual({ tool: 'onto_word_add', args: { term: 'owners', meaning: 'customers' } });
    expect(wordsPlan('Stop treating “owners” as customers')).toEqual({ tool: 'onto_word_remove', args: { term: 'owners' } });
    expect(wordsPlan('Which words have we added?')).toEqual({ tool: 'onto_words', args: {} });
    // Ordinary questions aren't words requests.
    for (const q of ['How many owners do we have?', 'Treat this as urgent please and show loans', 'What does DI mean by a share draft?']) expect(wordsPlan(q), q).toBeNull();
    expect(ADD_WORD.test('Show loans treated as charged off')).toBe(false);
  });
});

const SCHEMA = 'dinext_t_test_bank';
const ADMIN_URL = process.env.DI_DB_ADMIN_URL ?? 'mysql://root:dinext_local_root@127.0.0.1:3307';
const up = (await warehouseAvailable(SCHEMA)) && (await tenantPool(SCHEMA).query('SELECT 1 FROM onto_word LIMIT 1').then(() => true, () => false));
const CFO = { id: 'user:test-words', name: 'Morgan Ellis', title: 'CFO' };

describe.skipIf(!up)('an institution’s own words, at the bank', () => {
  let pool: Pool;
  let admin: Pool;
  let semantic: SemanticService;
  let approvals: ApprovalStore;
  let gateway: ModuleGateway;
  let spec: ModuleSpec;
  const turn = (text: string, threadId: string, modules = ['lineage', 'ontology-words']): ModuleTurn => ({ runId: `R-${threadId}`, threadId, text, user: CFO, tenant: { name: 'Coastal' }, modules });
  const sink = () => {
    const texts: string[] = [];
    const blocks: Block[] = [];
    const s: RunSink = { signal: new AbortController().signal, routing: () => {}, plan: () => 'blk_plan00000000', step: () => {}, text: async (m) => void texts.push(m), block: async (b) => void blocks.push(b), suggestion: () => {} };
    return { s, texts, blocks };
  };
  const ask = async (text: string, threadId: string, modules?: string[]) => {
    const r = sink();
    const out = await runModuleOffline(spec, turn(text, threadId, modules), { gateway }, r.s);
    for (const b of r.blocks) expect(validateBlock(b).ok, JSON.stringify(validateBlock(b))).toBe(true);
    return { out, text: r.texts.join(' '), blocks: r.blocks };
  };
  const approve = async (out: Awaited<ReturnType<typeof ask>>['out']) => {
    expect(out.approval, JSON.stringify(out).slice(0, 400)).toBeTruthy();
    const rec = out.approval!.record;
    const decided = await approvals.decide(rec.approvalId, { decision: 'approved', userId: CFO.id, payloadHash: rec.payloadHash });
    return JSON.stringify(await gateway.execute(decided, { user: CFO, modules: ['lineage', 'ontology-words'], runId: 'R-words-exec', threadId: `thr_words_exec_${rec.approvalId}` }));
  };
  const answer = async (q: string) => {
    const r = sink();
    const out = await runOffline(q, semantic, { canViewSql: false }, 'R-words-q', r.s, 'bank');
    return { outcome: out.outcome, text: r.texts.join(' '), blocks: r.blocks };
  };
  const clear = () => admin.query('DELETE FROM onto_word WHERE by_user = ?', [CFO.id]);

  beforeAll(async () => {
    pool = tenantPool(SCHEMA);
    admin = createPool(`${ADMIN_URL}/${SCHEMA}`);
    await clear();
    semantic = await SemanticService.create(pool, 'test_bank', 'bank');
    approvals = new ApprovalStore(pool);
    spec = lineageModule(new LineageService(pool, semantic.model), new OntologyService(pool, 'bank'), { store: new WordStore(pool), semantic, type: 'bank' });
    gateway = new ModuleGateway(approvals, [spec]);
  });
  afterAll(async () => {
    await clear();
    await semantic.refreshWords(true);
    await admin.end();
  });

  it('lists the questions DI couldn’t read, with what each word might mean', async () => {
    const r = await ask('Which questions couldn’t DI read?', 'thr_words1');
    expect(r.text).toMatch(/\*\*\d+ questions\*\* \(asked \d+ times\) in the last six months didn’t map to a defined measure\./);
    expect(r.text).toContain('“owners” could mean **customer** (A credit union uses “owner” for what you call a customer)');
    expect(r.text).toContain('“certficates” could mean **certificate of deposit**');
    expect(r.text).toMatch(/Nothing in DI’s ontology fits .*“promoter”/);
    const table = r.blocks.find((b) => b.type === 'table') as unknown as { data: { rows: { question: string; means: string }[] } };
    expect(table.data.rows.find((x) => x.question === 'How many owners do we have?')?.means).toBe('owners: customer (strong)');
  });

  it('adds a word only on approval, and then reads it in every question', async () => {
    expect((await answer('How many owners do we have?')).outcome).toBe('unmatched');
    // Without the role, no change is offered.
    const denied = await ask('Treat “owners” as customers', 'thr_words2', ['lineage']);
    expect(denied.text).toContain('isn’t part of your DI access');
    const asked = await ask('Treat “owners” as customers', 'thr_words3');
    expect(asked.out.approval?.card.data.summary ?? JSON.stringify(asked.out)).toContain('Read “owners” as customer');
    expect(await approve(asked.out)).toContain('DI now reads “owners” as **customer**');
    const after = await answer('How many owners do we have?');
    expect(after.outcome).toBe('answer');
    expect(after.text).toMatch(/customers/i);
    // The queue reads it now too, and the list shows who approved it.
    expect((await ask('Which questions couldn’t DI read?', 'thr_words4')).text).toMatch(/of them read now/);
    expect((await ask('Which words have we added?', 'thr_words5')).text).toContain('“owners” as customer');
  });

  it('refuses a word DI already defines, and a meaning it can’t find', async () => {
    expect((await ask('Treat “checking” as loans', 'thr_words6')).text).toContain('already means checking in DI’s ontology');
    expect((await ask('Treat “widgets” as flux capacitors', 'thr_words7')).text).toContain('I can’t find “flux capacitors” in DI’s ontology');
  });

  it('removes a word on approval', async () => {
    const asked = await ask('Stop treating “owners” as customers', 'thr_words8');
    await approve(asked.out);
    expect((await answer('How many owners do we have?')).outcome).toBe('unmatched');
  });
});
