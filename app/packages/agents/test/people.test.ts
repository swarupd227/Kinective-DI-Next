// @vitest-environment node
// People and roles from the ontology (Core Mapping and Ontology, phase 7): roles on an account in the
// ontology's words, and applicants matched to the people DI holds on the identity properties it
// weights, measured against the person each application is recorded against. No model calls.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { validateBlock, type Block } from '@dinext/block-schemas';
import { ApprovalStore, PeopleService, roleOf, scoreIdentity } from '@dinext/di-core';
import { ontology } from '@dinext/ontology';
import { tenantPool, warehouseAvailable, type Pool } from '@dinext/tenant-db';
import { ModuleGateway, runModuleOffline, type ModuleTurn, type RunSink } from '../src/index.ts';
import { PEOPLE_REQUEST, peopleModule } from '../src/people.ts';
import { jaroWinkler, oneSlipApart } from '../../di-core/src/people.ts';

describe('roles and identity in the ontology', () => {
  it('reads each role DI holds as the ontology’s role, with what it allows', () => {
    expect(roleOf('Joint')).toMatchObject({ id: 'joint', label: 'Joint owner' });
    expect(roleOf('Rep payee')).toMatchObject({ id: 'representative_payee', label: 'Representative payee' });
    expect(roleOf('Beneficiary').means).toBe('Receives the funds when the owner dies; has no access before then.');
    expect(roleOf('Signer').id).toBe('authorized_signer');
  });

  it('knows familiar names both ways', () => {
    expect(ontology().nicknames.get('robert')).toEqual(new Set(['bob', 'bobby', 'rob']));
    expect(ontology().nicknames.get('bob')?.has('robert')).toBe(true);
  });

  it('scores a person on the weighted identity properties: a familiar name nearly counts, a name alone never matches', () => {
    const nora = { first: 'Robert', last: 'Chen', birth: '1984-02-11', email: 'r.chen@example.com', street: '12 Elm St', zip: '06880' };
    expect(scoreIdentity(nora, nora)).toEqual({ score: 1, agreed: ['first name', 'last name', 'birth date', 'email', 'street', 'ZIP code'] });
    const bob = scoreIdentity({ ...nora, first: 'Bob' }, nora);
    expect(bob.score).toBeCloseTo(0.97, 2);
    expect(bob.agreed[0]).toBe('familiar first name');
    // The same name and ZIP with another birth date is at most for a person to check, never the same person.
    expect(scoreIdentity({ first: 'Robert', last: 'Chen', birth: '1990-01-01', zip: '06880' }, nora).score).toBe(0.6);
    expect(scoreIdentity({ first: 'Robert', last: 'Chen' }, { first: 'Robert', last: 'Chen', zip: '06880' }).score).toBe(1);
    // Details the applicant didn't give don't count against them; ones the record lacks do.
    expect(scoreIdentity({ first: 'Robert', last: 'Chen', birth: '1984-02-11' }, nora).score).toBe(1);
    expect(scoreIdentity(nora, { first: 'Robert', last: 'Chen', birth: '1984-02-11' }).score).toBe(0.7);
  });

  it('recognizes the questions it answers, and leaves the membership questions to Membership', () => {
    for (const q of ['Who is on account 1048231?', 'Who’s on account ending 4821?', 'Everyone with a say over account …4821', 'Which membership applicants are already members?', 'Match the applicants', 'Are any applicants already customers?'])
      expect(PEOPLE_REQUEST.test(q), q).toBe(true);
    for (const q of ['How many members joined last quarter?', 'Show membership applications this month', 'Why did members leave?', 'Who are our top members?']) expect(PEOPLE_REQUEST.test(q), q).toBe(false);
  });
});

const CU = 'dinext_t_test_cu';
const BANK = 'dinext_t_test_bank';
const up = (await warehouseAvailable(CU)) && (await warehouseAvailable(BANK));

describe.skipIf(!up)('against both warehouses', () => {
  const pools: Pool[] = [];
  beforeAll(() => {
    pools.push(tenantPool(CU), tenantPool(BANK));
  });
  afterAll(async () => {
    for (const p of pools) await p.end();
  });
  const ask = async (pool: Pool, type: 'credit_union' | 'bank', text: string, id: string, purviewBranches?: string[]) => {
    const spec = peopleModule(new PeopleService(pool, type), type === 'bank' ? 'customer' : 'member');
    const gateway = new ModuleGateway(new ApprovalStore(pool), [spec]);
    const texts: string[] = [];
    const blocks: Block[] = [];
    const sink: RunSink = { signal: new AbortController().signal, routing: () => {}, plan: () => 'blk_plan00000000', step: () => {}, text: async (m) => void texts.push(m), block: async (b) => void blocks.push(b), suggestion: () => {} };
    const turn: ModuleTurn = { runId: `R-ppl-${id}`, threadId: id, text, user: { id: 'user:9229', name: 'Dana Lee', title: 'CEO' }, tenant: { name: 'Harborview' }, modules: ['membership'], purviewBranches };
    await runModuleOffline(spec, turn, { gateway }, sink);
    for (const b of blocks) expect(validateBlock(b).ok, JSON.stringify(validateBlock(b))).toBe(true);
    return { text: texts.join(' '), blocks };
  };

  it('lists everyone on an account in the ontology’s roles, with what each allows', async () => {
    const [[acct]] = (await pools[0]!.query("SELECT o.account_id AS id FROM cdm_account_owner o WHERE o.account_kind = 'deposit' AND o.role = 'Beneficiary' ORDER BY o.account_id LIMIT 1")) as unknown as [{ id: number }[]];
    const r = await ask(pools[0]!, 'credit_union', `Who is on share account ${acct!.id}?`, 'p1');
    expect(r.text).toMatch(new RegExp(`account ending ${String(acct!.id).slice(-4)}\\*\\* has \\d+ (people|person) on it: \\*\\*[^*]+\\*\\*, primary owner`));
    expect(r.text).toContain('beneficiary (receives the funds when the owner dies; has no access before then)');
    const table = r.blocks[0] as Extract<Block, { type: 'table' }>;
    expect(table.data.rows!.map((x) => x.role)).toContain('Beneficiary');
    // Someone outside the asker's branches is counted, not named.
    const none = await ask(pools[0]!, 'credit_union', `Who is on share account ${acct!.id}?`, 'p2', ['Nowhere']);
    expect(none.text).toMatch(/none you can see\. \d+ more (people|person) (are|is) on it outside your branches/);
  });

  it('asks for the whole number when the last four digits fit several accounts', async () => {
    const r = await ask(pools[0]!, 'credit_union', 'Who is on account 0001?', 'p3');
    expect(r.text).toMatch(/accounts end in 0001\. Give the whole account number|No share, deposit or loan account ends in 0001/);
    // Share and loan numbers are separate series: a number that is one of each needs saying which.
    const both = await ask(pools[0]!, 'credit_union', 'Who is on account 13?', 'p3b');
    expect(both.text).toContain('13 is both a share account and a loan. Say which');
    expect((await ask(pools[0]!, 'credit_union', 'Who is on loan 13?', 'p3c')).text).toMatch(/loan ending 13\*\* has/);
  });

  it('matches every applicant the application links to a person as that person, and leaves the rest new or for a person to check', async () => {
    let familiar = 0;
    for (const [pool, type] of [[pools[0]!, 'credit_union'], [pools[1]!, 'bank']] as const) {
      const r = await new PeopleService(pool, type).matchApplicants();
      expect(r.all.linked, type).toBeGreaterThan(1000);
      expect(r.all.same, type).toBe(r.all.linked);
      expect(r.all.sameRight, type).toBe(r.all.linked);
      expect(r.all.missed, type).toBe(0);
      expect(r.existing.sameRight, type).toBe(r.existing.applicants);
      familiar += r.rows.filter((x) => x.existing && x.result.agreed.includes('familiar first name')).length;
      // Applicants linked to nobody are never matched as the same person; a few are left for a person to check.
      expect(r.unlinked.same, type).toBe(0);
      expect(r.unlinked.possible, type).toBeLessThan(r.unlinked.applicants * 0.01);
    }
    // Some were members under a familiar form of their first name.
    expect(familiar).toBeGreaterThan(0);
    const said = await ask(pools[0]!, 'credit_union', 'Which membership applicants are already members?', 'p4');
    expect(said.text).toMatch(/^Of \*\*[\d,]+ membership applicants\*\*, DI matched \*\*[\d,]+\*\* to a member it already holds as the same person, each the member the application is recorded against/);
    expect(said.text).toContain('birth date 30%, last name 25%');
  }, 120_000);
});

describe('matching that allows for slips (phase 8)', () => {
  const rec = { first: 'Robert', last: 'Chen', birth: '1984-02-11', email: 'r.chen@example.com', street: '12 Elm St', zip: '06880' };

  it('rates a typo as close and a different name as far', () => {
    expect(jaroWinkler('martinez', 'martniez')).toBeGreaterThan(0.92);
    expect(jaroWinkler('johnson', 'jonson')).toBeGreaterThan(0.92);
    expect(jaroWinkler('nguyen', 'nolan')).toBeLessThan(0.92);
    // A dropped letter near the end scores lower, so one slip apart counts too.
    expect(oneSlipApart('greene', 'grene')).toBe(true);
    expect(oneSlipApart('yamamoto', 'ymamoto')).toBe(true);
    expect(oneSlipApart('chen', 'chne')).toBe(true);
    expect(oneSlipApart('smith', 'smyth')).toBe(true);
    expect(oneSlipApart('smith', 'jones')).toBe(false);
    expect(oneSlipApart('anderson', 'andersen ')).toBe(false);
    expect(jaroWinkler('smith', 'smith')).toBe(1);
  });

  it('gives partial credit for a misspelled name, a swapped day and month, and a street written out', () => {
    const typo = scoreIdentity({ ...rec, last: 'Chne' }, rec);
    expect(typo.agreed).toContain('last name (spelled differently)');
    expect(scoreIdentity({ ...rec, last: 'Chne' }, rec, { fuzzy: false }).agreed).not.toContain('last name (spelled differently)');
    expect(typo.score).toBeGreaterThan(scoreIdentity({ ...rec, last: 'Chne' }, rec, { fuzzy: false }).score);
    expect(scoreIdentity({ ...rec, birth: '1984-11-02' }, rec).agreed).toContain('birth date (day and month swapped)');
    // "Street" and "St" are one word to the ontology, matching exactly or not.
    expect(scoreIdentity({ ...rec, street: '12 Elm Street' }, rec, { fuzzy: false }).agreed).toContain('street');
    expect(scoreIdentity({ ...rec, street: '12 Elms St' }, rec).agreed).toContain('street (spelled differently)');
    // A different house number is a different address, however alike the street.
    expect(scoreIdentity({ ...rec, street: '14 Elm St' }, rec).agreed.some((a) => a.startsWith('street'))).toBe(false);
  });
});

describe.skipIf(!up)('the matching trial against both warehouses', () => {
  it('decides more altered records on its own and none wrongly, and leaves made-up people new', async () => {
    for (const [schema, type] of [[CU, 'credit_union'], [BANK, 'bank']] as const) {
      const pool = tenantPool(schema);
      try {
        const r = await new PeopleService(pool, type).matchTrial(40);
        const by = (k: string) => r.kinds.find((x) => x.kind === k)!;
        for (const k of r.kinds) {
          expect(k.fuzzy.wrong, `${type} ${k.kind}`).toBe(0);
          expect(k.fuzzy.missed, `${type} ${k.kind}`).toBe(0);
          expect(k.fuzzy.same, `${type} ${k.kind}`).toBeGreaterThanOrEqual(k.exact.same);
        }
        expect(by('Last name misspelled').exact.same, type).toBe(0);
        expect(by('Last name misspelled').fuzzy.same, type).toBeGreaterThanOrEqual(32);
        expect(by('Birth day and month swapped').fuzzy.same, type).toBe(40);
        expect(r.strangers.fuzzy.same, type).toBe(0);
        expect(r.strangers.fuzzy.wrong, type).toBeLessThanOrEqual(2);
      } finally {
        await pool.end();
      }
    }
  }, 120_000);
});