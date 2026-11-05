// Membership growth and penetration: the questions it answers, and a member book that behaves like a
// real credit union's on the seeded warehouse.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { MembershipService } from '@dinext/di-core';
import { tenantPool, warehouseAvailable, type Pool } from '@dinext/tenant-db';
import { membershipModule } from '../src/membership.ts';
import { GOAL_REQUEST } from '../src/index.ts';

describe('membership questions', () => {
  const spec = membershipModule({} as MembershipService);
  const plan = (t: string) => spec.plan!(t, {} as never);
  it('routes each question to the right tool', () => {
    expect(plan('How fast are we really growing?')).toEqual({ tool: 'mem_growth', args: {} });
    expect(plan('What is our member attrition rate?')).toEqual({ tool: 'mem_growth', args: {} });
    expect(plan('Why are members leaving?')).toEqual({ tool: 'mem_exits', args: {} });
    expect(plan('Which branches are growing?')).toEqual({ tool: 'mem_branches', args: {} });
    expect(plan('Show penetration by age band')).toEqual({ tool: 'mem_penetration', args: { focus: 'age' } });
    expect(plan('What share of members have direct deposit?')).toEqual({ tool: 'mem_penetration', args: { focus: 'overall' } });
    expect(plan('Are new members staying?')).toEqual({ tool: 'mem_new_members', args: {} });
  });

  it('leaves at-risk members and their follow-ups to the Relationship Manager and the Goal agent', () => {
    expect(spec.request.test('Why are members leaving?')).toBe(true);
    expect(spec.request.test('What are products per member?')).toBe(true);
    expect(spec.request.test('Find members at risk of leaving and draft follow-ups')).toBe(false);
    expect(GOAL_REQUEST.test('Find members at risk of leaving and draft follow-ups')).toBe(true);
    expect(spec.request.test('How many members do we have?')).toBe(false);
    expect(spec.request.test('Which branches are growing?')).toBe(true);
    expect(spec.request.test('Which branches are growing loans fastest?')).toBe(false);
  });
});

const SCHEMA = 'dinext_t_test_cu';
const up = await warehouseAvailable(SCHEMA);

describe.skipIf(!up)('membership on the warehouse', () => {
  let pool: Pool;
  beforeAll(() => {
    pool = tenantPool(SCHEMA);
  });
  afterAll(async () => pool.end());

  it('grows 1–3% a year net, loses 5–8%, and the months add up', async () => {
    const svc = new MembershipService(pool);
    const g = await svc.growth();
    expect(g.netGrowthPct).toBeGreaterThan(0.5);
    expect(g.netGrowthPct).toBeLessThan(3);
    expect(g.attritionPct).toBeGreaterThan(5);
    expect(g.attritionPct).toBeLessThan(8);
    // Each month's members are last month's plus joins less exits.
    const [a, b] = g.months.slice(-2);
    expect(b!.members - a!.members).toBe(b!.joined - b!.left);
    // Branches add up to the institution.
    const bs = await svc.branches();
    expect(bs.reduce((s, x) => s + x.members, 0)).toBe(g.members);
  });

  it('says why members left, and a third leave in their first year', async () => {
    const x = await new MembershipService(pool).exits();
    expect(x.reasons.reduce((s, r) => s + r.count, 0)).toBe(x.total);
    expect(x.reasons[0]!.reason).toBe('Moved away');
    expect(x.firstYearPct).toBeGreaterThan(25);
    expect(x.firstYearPct).toBeLessThan(45);
  });

  it('has deeper relationships in mid-life than at either end, and seniors are least digital', async () => {
    const p = await new MembershipService(pool).penetration();
    const band = (b: string) => p.ages.find((a) => a.band === b)!;
    expect(band('35–49').loan).toBeGreaterThan(band('18–24').loan + 10);
    expect(band('35–49').loan).toBeGreaterThan(band('65+').loan + 10);
    expect(band('65+').digital).toBeLessThan(band('25–34').digital - 10);
    expect(p.now.productsPerMember).toBeGreaterThan(2);
    expect(p.now.productsPerMember).toBeLessThan(3);
    expect(p.now.checking).toBeGreaterThan(55);
    expect(p.ages.reduce((s, a) => s + a.members, 0)).toBe(p.now.members);
  });

  it('keeps former members out of the member table', async () => {
    const [rows] = await pool.query('SELECT COUNT(*) AS n FROM cdm_party p JOIN cdm_membership_exit x ON x.party_id = p.party_id');
    expect(Number((rows as { n: number }[])[0]!.n)).toBe(0);
  });
});
