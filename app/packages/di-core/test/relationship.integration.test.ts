// @vitest-environment node
// Relationship Manager operations against the seeded warehouse (spec 8.24, 17.2, 24.15). Purview is
// tested for every way a person can be looked up (AI-TRG-021).
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createPool, tenantPool, warehouseAvailable, type Pool } from '@dinext/tenant-db';
import { memberToken, partyFromToken, RelationshipService } from '../src/index.ts';

const available = await warehouseAvailable('dinext_t_test_cu');
let pool: Pool;
let admin: Pool;
let rm: RelationshipService;

// Robert Jackson (party 19) banks at Northgate; the Westport manager must never reach him.
const ROBERT = { partyId: 19, number: '10004539', phone: '5550150461', email: 'robert.jackson19@example.com' };
const westport = { purviewBranches: ['Westport'] };

beforeAll(async () => {
  if (!available) return;
  pool = tenantPool('dinext_t_test_cu');
  admin = createPool(`${process.env.DI_DB_ADMIN_URL ?? 'mysql://root:dinext_local_root@127.0.0.1:3307'}/dinext_t_test_cu`);
  rm = new RelationshipService(pool, 'test_cu', 'credit_union');
  // The demo member starts with every suggestion active, whatever earlier demos declined.
  await admin.query('DELETE FROM mod_suggestion_decline WHERE party_id IN (1, 99)');
});
afterAll(async () => {
  if (!available) return;
  await admin.query("DELETE FROM mod_suggestion_decline WHERE approval_id LIKE 'apr_testDecl%'");
  await Promise.all([pool.end(), admin.end()]);
});

describe('member tokens (FE-ARCH-011)', () => {
  it('round-trip, are opaque, and mean nothing in another tenant or when altered', () => {
    const t = memberToken('test_cu', 1);
    expect(t).toMatch(/^mbr_[A-Za-z0-9_-]{22}$/);
    expect(t).not.toContain('4521');
    expect(partyFromToken('test_cu', t)).toBe(1);
    expect(partyFromToken('test_bank', t)).toBeNull();
    expect(partyFromToken('test_cu', `${t.slice(0, -2)}AA`)).toBeNull();
    expect(partyFromToken('test_cu', 'mbr_1')).toBeNull();
  });
});

describe.skipIf(!available)('relationship.party.search (BE-RM-002)', () => {
  it('finds a member by name, name and branch, member number, last four, phone and email', async () => {
    const one = async (q: string) => (await rm.search(q, {})).map((h) => `${h.name}|${h.matchedOn}`);
    expect(await one('Suzanne Jackson')).toEqual(['Suzanne Jackson|name']);
    expect(await one('suzanne jackson at westport')).toEqual(['Suzanne Jackson|name']);
    expect(await one('10004521')).toEqual(['Suzanne Jackson|number']);
    expect(await one('jackson 4521')).toEqual(['Suzanne Jackson|name']);
    expect(await one('(555) 015-0461')).toEqual(['Robert Jackson|phone']);
    expect(await one('Robert.Jackson19@example.com')).toEqual(['Robert Jackson|email']);
    const byLast4 = await rm.search('…4521', westport);
    expect(byLast4.length).toBeGreaterThan(1);
    expect(byLast4.every((h) => h.last4 === '4521' && h.branch === 'Westport')).toBe(true);
  });

  it('returns masked results only', async () => {
    const [h] = await rm.search('Suzanne Jackson', {});
    expect(Object.keys(h!).sort()).toEqual(['branch', 'firstName', 'last4', 'matchedOn', 'memberSince', 'name', 'partyId', 'products']);
  });

  it('never reaches a member outside the purview, by any way of asking (AI-TRG-021)', async () => {
    for (const q of ['Robert Jackson', 'Robert Jackson at Northgate', ROBERT.number, `jackson ${ROBERT.number.slice(-4)}`, ROBERT.phone, ROBERT.email]) {
      expect((await rm.search(q, {})).map((h) => h.partyId), q).toContain(ROBERT.partyId);
      expect((await rm.search(q, westport)).map((h) => h.partyId), q).not.toContain(ROBERT.partyId);
    }
    await expect(rm.profile(ROBERT.partyId, westport)).rejects.toMatchObject({ code: 'NO_ACCESS' });
    await expect(rm.resolve(memberToken('test_cu', ROBERT.partyId), westport)).rejects.toMatchObject({ code: 'NO_ACCESS' });
    // An empty purview sees nobody.
    expect(await rm.search('Suzanne Jackson', { purviewBranches: [] })).toEqual([]);
  });
});

describe.skipIf(!available)('relationship.profile.get (FE-RM-001, BE-RM-001)', () => {
  it('assembles the demo member’s 360 from the build', async () => {
    const p = await rm.profile(1, westport);
    expect(p).toMatchObject({ name: 'Suzanne Jackson', last4: '4521', branch: 'Westport', segment: 'Young Adult', person: 'member', asOf: { buildId: 'bld_20261026' } });
    expect(p.deposits.map((a) => `${a.name} …${a.suffix}`)).toEqual(['Share Savings …0001']);
    expect(p.attrition).toMatchObject({ score: 6, band: 'Medium', model: 'attrition_v4', runDate: '2026-10-25' });
    expect(p.attrition.factors[0]).toMatchObject({ code: 'balance_drop', weight: 2 });
    expect(p.applications).toMatchObject({ pending: 1, items: [{ product: 'Auto loan', amount: 18500, detail: 'Waiting for a pay stub' }] });
    // A pending auto application keeps "Auto loan" out of the suggestions.
    expect(p.opportunities.map((o) => o.product)).toEqual(['Checking', 'Credit card']);
    expect(p.contact.email).toBe('s•••@example.com');
    expect(p.contact.phone).toMatch(/^\(•••\) •••-\d{4}$/);
    // Maria Gomez shares the household but banks at Downtown: counted, never named.
    expect(p.household).toEqual([{ name: null, branch: null, last4: null, inPurview: false }]);
    expect((await rm.profile(1, {})).household[0]).toMatchObject({ name: 'Maria Gomez', inPurview: true });
  });

  it('ranks the next best conversation by the fixed rule (spec 24.15)', async () => {
    const topics = rm.nextBestConversation(await rm.profile(1, westport));
    expect(topics.map((t) => t.kind)).toEqual(['pending_application', 'retention_risk', 'product_opportunity', 'product_opportunity', 'digital_gap']);
    expect(topics[1]!.reason).toBe('Attrition score 6 on a 0–10 scale; reason: deposit balances down 18% in 30 days; holds only one product');
    expect(topics[3]!.refer).toEqual({ product: 'Credit card', referralTypeId: 'credit_card' });
  });

  it('explains a score with its factors and run date (FE-RM-002)', async () => {
    const e = rm.explain(await rm.profile(1, westport), 'attrition');
    expect(e).toMatchObject({ value: '6 of 10 (Medium)', model: 'attrition_v4', runDate: '2026-10-25' });
    expect(e.factors[0]).toEqual({ label: 'Deposit balances down 18% in 30 days', effect: 'raises the score by 2' });
  });
});

describe.skipIf(!available)('relationship.suggestion.decline (spec 17.2)', () => {
  // Victor Patel (party 99, Westport) has a HELOC suggestion; the demo member is left untouched.
  it('hides the suggestion for 90 days, records it once per approval, and shows it as an interaction', async () => {
    const meta = { approvalId: 'apr_testDecl0001', userId: 'user:5120', userName: 'Marcus Reed' };
    expect((await rm.profile(99, westport)).opportunities.map((o) => o.product)).toContain('HELOC');
    const first = await rm.decline({ partyId: 99, suggestionId: 220, product: 'HELOC' }, meta, westport);
    await rm.decline({ partyId: 99, suggestionId: 220, product: 'HELOC' }, meta, westport);
    expect(first).toEqual({ product: 'HELOC', until: '2027-01-23' });
    const [rows] = await admin.query("SELECT COUNT(*) AS n FROM mod_suggestion_decline WHERE approval_id = 'apr_testDecl0001'");
    expect((rows as { n: number }[])[0]!.n).toBe(1);
    const p = await rm.profile(99, westport);
    expect(p.opportunities.map((o) => o.product)).not.toContain('HELOC');
    expect(p.declined).toContainEqual({ product: 'HELOC', until: '2027-01-23', by: 'Marcus Reed' });
    expect(p.interactions.items[0]).toMatchObject({ kind: 'Offer declined', summary: 'Declined the HELOC offer', by: 'Marcus Reed' });
    await expect(rm.decline({ partyId: ROBERT.partyId, suggestionId: 1, product: 'x' }, { ...meta, approvalId: 'apr_testDecl0002' }, westport)).rejects.toMatchObject({ code: 'NO_ACCESS' });
  });
});
