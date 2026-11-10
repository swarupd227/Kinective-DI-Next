// @vitest-environment node
// Loan Growth: members who borrow elsewhere or could qualify, from their own accounts, and measured
// outreach with a control group held back at random in each segment.
import { describe, expect, it } from 'vitest';
import { LoanGrowthService, type CampaignService } from '@dinext/di-core';
import { tenantPool, warehouseAvailable } from '@dinext/tenant-db';
import { LOAN_GROWTH_REQUEST, campaignModule, lgQuestion, lgSegments, loanGrowthModule } from '../src/index.ts';

const USE_CASE = 'Find members who have an auto loan or HELOC at another lender, or the equity and credit to qualify for one, and prepare a measured outreach campaign with a control group.';

describe('loan growth questions', () => {
  const spec = loanGrowthModule({} as LoanGrowthService);
  const plan = (t: string) => spec.plan(t, {} as never);
  it('route to the right tool, and leave plain campaign questions to Campaigns', () => {
    expect(plan(USE_CASE)).toEqual({ tool: 'lg_prepare', args: { segments: ['auto_elsewhere', 'auto_credit', 'heloc_elsewhere', 'heloc_equity'] } });
    expect(plan('Who has an auto loan with another lender?')).toEqual({ tool: 'lg_find', args: { question: 'auto' } });
    expect(plan('Which members have the equity and credit to qualify for a HELOC?')).toEqual({ tool: 'lg_find', args: { question: 'equity' } });
    expect(plan('How did the July auto refinance campaign do?')).toEqual({ tool: 'lg_results', args: {} });
    expect(plan('Send the loan growth campaign')).toEqual({ tool: 'lg_send', args: {} });
    expect(plan('Prepare a measured outreach campaign for members paying a HELOC elsewhere, with a 20% control group')).toEqual({ tool: 'lg_prepare', args: { segments: ['heloc_elsewhere'], holdout_pct: 20 } });
    for (const q of [USE_CASE, 'Who has an auto loan with another lender?', 'Which members have the equity and credit to qualify for a HELOC?', 'How did the July auto refinance campaign do?']) expect(LOAN_GROWTH_REQUEST.test(q), q).toBe(true);
    const cmp = campaignModule({} as CampaignService);
    for (const q of ['Which campaigns paid for themselves?', 'Build an audience of members with no auto loan']) {
      expect(LOAN_GROWTH_REQUEST.test(q), q).toBe(false);
      expect(cmp.request.test(q), q).toBe(true);
    }
    expect(lgQuestion('Which lenders do our members pay?')).toBe('lenders');
    expect(lgSegments('members with auto loans elsewhere')).toEqual(['auto_elsewhere']);
  });

  it('holds back the same random share of every segment, the same way each time', () => {
    const people = Array.from({ length: 1000 }, (_, i) => ({ partyId: i + 1, segment: i < 600 ? 'a' : 'b' }));
    const s = LoanGrowthService.split(people, 10, 'Campaign one');
    expect(s.filter((p) => p.segment === 'a' && p.arm === 'control')).toHaveLength(60);
    expect(s.filter((p) => p.segment === 'b' && p.arm === 'control')).toHaveLength(40);
    expect(LoanGrowthService.split(people, 10, 'Campaign one').map((p) => p.arm)).toEqual(s.map((p) => p.arm));
    // A different campaign draws a different control group, and it isn't just the lowest member numbers.
    const other = LoanGrowthService.split(people, 10, 'Campaign two').filter((p) => p.arm === 'control').map((p) => p.partyId);
    expect(other).not.toEqual(s.filter((p) => p.arm === 'control').map((p) => p.partyId));
    expect(Math.max(...other)).toBeGreaterThan(500);
  });
});

const up = await warehouseAvailable('dinext_t_test_cu').then((ok) => ok && tenantPool('dinext_t_test_cu').query('SELECT 1 FROM cdm_transaction LIMIT 1').then(() => true, () => false));
describe.skipIf(!up)('a credit union’s loan growth prospects', () => {
  it('finds loans elsewhere from steady ACH payments, qualifies members, and measures the July campaign', async () => {
    const pool = tenantPool('dinext_t_test_cu');
    try {
      const svc = new LoanGrowthService(pool);
      const o = (await svc.outside())!;
      // Card payments vary and aren't loans; a loan that moved to the credit union stopped being paid.
      expect(o.cardIssuersIgnored).toBeGreaterThan(0);
      expect(o.payments.every((p) => p.kind !== ('card' as string))).toBe(true);
      expect(o.payments.filter((p) => p.stopped).length).toBeGreaterThan(50);
      const x = await svc.prospects({} as never);
      for (const s of x.segments) expect(s.members, s.segment).toBeGreaterThan(100);
      // One segment a member; opt-outs and recent contacts never appear.
      expect(new Set(x.prospects.map((p) => p.partyId)).size).toBe(x.prospects.length);
      expect(x.prospects.some((p) => p.partyId % 9 === 0 || p.partyId % 13 === 0)).toBe(false);
      // Members already holding the product with the credit union aren't offered it.
      const [held] = (await pool.query("SELECT DISTINCT party_id FROM cdm_loan WHERE loan_category = 'Auto' AND close_date IS NULL")) as unknown as [{ party_id: number }[]];
      const autoHolders = new Set(held.map((h) => h.party_id));
      expect(x.prospects.filter((p) => p.segment.startsWith('auto') && autoHolders.has(p.partyId))).toHaveLength(0);
      expect(x.prospects.filter((p) => p.segment === 'heloc_equity').every((p) => (p.line ?? 0) >= 25_000 && (p.score ?? 0) >= 700)).toBe(true);

      const r = await svc.results(1);
      expect(r.total.treatmentRatePct).toBeGreaterThan(r.total.controlRatePct);
      expect(r.total.significant).toBe(true);
      expect(r.total.incremental).toBeCloseTo(((r.total.treatmentRatePct - r.total.controlRatePct) / 100) * r.total.treatment, 6);
      expect(r.total.moved).toBeGreaterThan(0);

      const spec = loanGrowthModule(svc);
      const ctx = { user: { id: 'u', name: 'Dana Lee' }, modules: ['loangrowth'], runId: 'r', threadId: 't' };
      const tool = (n: string) => spec.tools.find((t) => t.name === n)!;
      const prep = (await tool('lg_prepare').run({ segments: ['auto_elsewhere', 'heloc_elsewhere', 'heloc_equity', 'auto_credit'] } as never, ctx)) as { change: { text: string; apply: { holdoutPct: number; members: { arm: string }[] } } };
      expect(prep.change.text).toMatch(/^\*\*[\d,]+ members\*\* could borrow from us: \*\*[\d,]+\*\* pay an auto loan to another lender/);
      expect(prep.change.text).toMatch(/hold back a random \*\*10%\*\* of each segment/);
      const control = prep.change.apply.members.filter((m) => m.arm === 'control').length;
      expect(control / prep.change.apply.members.length).toBeCloseTo(0.1, 2);
      const res = (await tool('lg_results').run({} as never, ctx)) as { text: string };
      expect(res.text).toMatch(/a lift of \*\*\d+\.\d points\*\*, more than chance would explain/);
      await expect(tool('lg_find').run({} as never, { ...ctx, modules: [] })).rejects.toThrow(/aren’t part of your DI access/);
    } finally {
      await pool.end();
    }
  });
});
