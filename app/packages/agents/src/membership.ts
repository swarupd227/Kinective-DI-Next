// Membership growth and penetration on the shared module agent: net growth and attrition, why members
// leave, growth by branch, relationship depth by branch and age band, and how new members are doing.
// Read-only and under the viewer's purview.
import { z } from 'zod';
import { CoreError, MEMBERSHIP_BENCHMARKS, type MembershipService } from '@dinext/di-core';
import { moduleTable, type ModuleContext, type ModuleSpec } from './moduleAgent.ts';

const NO_ACCESS = 'Membership growth isn’t part of your DI access. It is for executives, the finance and marketing teams and branch managers.';
const guard = (ctx: ModuleContext) => {
  if (!ctx.modules.includes('membership')) throw new CoreError('NO_ACCESS', NO_ACCESS);
};
const p1 = (n: number) => `${n.toFixed(1)}%`;
const n0 = (n: number) => Math.round(n).toLocaleString('en-US');
const signed = (n: number) => `${n >= 0 ? '+' : '−'}${n0(Math.abs(n))}`;

export function membershipModule(svc: MembershipService): ModuleSpec {
  const scope = (ctx: ModuleContext) => ({ purviewBranches: ctx.purviewBranches });
  const spec: ModuleSpec = {
    id: 'membership',
    prefix: 'mem',
    agent: 'Membership',
    request: /\b(member|customer|membership) (attrition|churn|growth|exits?)\b|\battrition rate\b|\bchurn rate\b|\b(members|customers) (who )?(left|leave|leaving|closed)\b(?!.*\b(follow-?ups?|draft|at risk)\b)|\bwhy (did|do|are) (members|customers) (leave|leaving)|\bclosed memberships?\b|\bnet (member |customer )?growth\b|\bhow fast are we (really )?growing\b|\bbranch(es)? (are |is )?(growing|shrinking)( fastest| most)?\s*\??\s*$|\bpenetration\b|\bproducts? per (member|customer)\b|\bcross-?sell ratio\b|\brelationship depth\b|\b(members|customers) (with|have|has) (checking|a loan|loans|direct deposit)\b|\bshare of (members|customers) with\b|\bdigital (adoption|penetration)\b|\bnew (members|customers) (stay|stick|staying|leave|leaving|doing)\b/i,
    noAccess: NO_ACCESS,
    sources: [
      { kind: 'table', label: 'Member history (month-end)', ref: 'table:hist_party_month' },
      { kind: 'table', label: 'Member penetration (month-end)', ref: 'table:hist_member_month' },
    ],
    prompt: ({ tenant, user, title }) => `You are the Membership agent inside Kinective Data Intelligence (DI) for ${tenant}. ${user} (${title}) looks after membership growth. DI has who joined, who left (from the core's closed-membership extract, with the reason recorded), the member count at each month-end, and how many members hold checking, a loan, direct deposit and active digital banking, by branch and age band. Most credit unions lose ${MEMBERSHIP_BENCHMARKS.attritionPct[0]}% to ${MEMBERSHIP_BENCHMARKS.attritionPct[1]}% of members a year and grow ${MEMBERSHIP_BENCHMARKS.netGrowthPct[0]}% to ${MEMBERSHIP_BENCHMARKS.netGrowthPct[1]}% net.

- "How fast are we growing?", "what's our attrition rate?", "net member growth": mem_growth.
- "Why are members leaving?", "closed memberships": mem_exits.
- "Which branches are growing?", "attrition by branch": mem_branches.
- "What share of members have checking?", "products per member", "penetration by age": mem_penetration with focus.
- "Are new members staying?": mem_new_members.
- You only read. For named members at risk of leaving, offer the Relationship Manager's at-risk list.`,
    plan: (text) => {
      const t = text.toLowerCase();
      if (/\bnew (members|customers)\b.*\b(stay|stick|leav|doing)|first year/.test(t)) return { tool: 'mem_new_members', args: {} };
      if (/why|reason|closed memberships?/.test(t)) return { tool: 'mem_exits', args: {} };
      if (/penetration|products? per|cross-?sell|depth|(with|have|has) (checking|a loan|loans|direct deposit)|share of (members|customers)|digital/.test(t)) return { tool: 'mem_penetration', args: { focus: /\bage|young|older|generation|senior/.test(t) ? 'age' : /branch/.test(t) ? 'branch' : 'overall' } };
      if (/branch/.test(t)) return { tool: 'mem_branches', args: {} };
      return { tool: 'mem_growth', args: {} };
    },
    tools: [
      {
        name: 'mem_growth',
        description: 'Net member growth and the annual attrition rate over the last twelve months, with joins and exits by month.',
        input: z.object({}).strict(),
        run: async (_: unknown, ctx) => {
          guard(ctx);
          const g = await svc.growth(scope(ctx));
          const [lo, hi] = MEMBERSHIP_BENCHMARKS.attritionPct;
          const pace = g.priorNet === null ? '' : g.net > g.priorNet * 1.1 ? ' Growth is faster than the year before.' : g.net < g.priorNet * 0.9 ? ' Growth is slower than the year before.' : '';
          return {
            text: `Membership grew **${p1(g.netGrowthPct)}** over the year to ${g.latest.label}, to **${n0(g.members)}** members: **${n0(g.joined)}** joined and **${n0(g.left)}** left. Annual attrition is **${p1(g.attritionPct)}**, ${g.attritionPct < lo ? 'below' : g.attritionPct > hi ? 'above' : 'within'} the ${lo}–${hi}% most credit unions see.${pace}`,
            blocks: [moduleTable(spec, 'Joins, exits and members by month', ctx.runId, 'mem.growth', [{ field: 'month', headerName: 'Month', type: 'text' }, { field: 'joined', headerName: 'Joined', type: 'count' }, { field: 'left', headerName: 'Left', type: 'count' }, { field: 'net', headerName: 'Net', type: 'count' }, { field: 'members', headerName: 'Members', type: 'count' }], g.months.slice(-12).map((m) => ({ month: m.label, joined: m.joined, left: m.left, net: m.net, members: m.members })))],
            suggestions: ['Why are members leaving?', 'Which branches are growing?'],
          };
        },
      },
      {
        name: 'mem_exits',
        description: 'Why members left over the last twelve months, by reason recorded at closing, and the share who left in their first year.',
        input: z.object({}).strict(),
        run: async (_: unknown, ctx) => {
          guard(ctx);
          const x = await svc.exits(scope(ctx));
          const [a, b] = x.reasons;
          const fintech = x.reasons.find((r) => /bank or fintech/i.test(r.reason));
          return {
            text: `**${n0(x.total)}** memberships closed in the last twelve months. The most common reason was **${a?.reason.toLowerCase() ?? 'not recorded'}** (${p1(a?.pct ?? 0)})${b ? `, then ${b.reason.toLowerCase()} (${p1(b.pct)})` : ''}.${fintech && fintech !== a ? ` ${p1(fintech.pct)} moved to a bank or fintech.` : ''} **${p1(x.firstYearPct)}** left within their first year, which is where onboarding helps most. Reasons are what the core recorded at closing.`,
            blocks: [moduleTable(spec, 'Why members left, last 12 months', ctx.runId, 'mem.exits', [{ field: 'reason', headerName: 'Reason', type: 'text' }, { field: 'count', headerName: 'Members', type: 'count' }, { field: 'pct', headerName: 'Share', type: 'text' }], x.reasons.map((r) => ({ reason: r.reason, count: r.count, pct: p1(r.pct) })))],
            suggestions: ['Are new members staying?', 'Show members at risk of leaving'],
          };
        },
      },
      {
        name: 'mem_branches',
        description: 'Net growth and attrition by branch over the last twelve months.',
        input: z.object({}).strict(),
        run: async (_: unknown, ctx) => {
          guard(ctx);
          const bs = await svc.branches(scope(ctx));
          const best = [...bs].sort((x, y) => y.netGrowthPct - x.netGrowthPct)[0]!;
          const worst = [...bs].sort((x, y) => y.attritionPct - x.attritionPct)[0]!;
          return {
            text: bs.length === 1 ? `${best.branch} ${best.net >= 0 ? 'grew' : 'shrank'} ${p1(Math.abs(best.netGrowthPct))} over the year (${signed(best.net)} members), with attrition of ${p1(best.attritionPct)}.` : `**${best.branch}** grew fastest, **${p1(best.netGrowthPct)}** over the year. **${worst.branch}** loses the most, **${p1(worst.attritionPct)}** a year.`,
            blocks: [moduleTable(spec, 'Membership by branch, last 12 months', ctx.runId, 'mem.branches', [{ field: 'branch', headerName: 'Branch', type: 'text' }, { field: 'members', headerName: 'Members', type: 'count' }, { field: 'joined', headerName: 'Joined', type: 'count' }, { field: 'left', headerName: 'Left', type: 'count' }, { field: 'growth', headerName: 'Net growth', type: 'text' }, { field: 'attrition', headerName: 'Attrition', type: 'text' }], bs.map((b) => ({ branch: b.branch, members: b.members, joined: b.joined, left: b.left, growth: p1(b.netGrowthPct), attrition: p1(b.attritionPct) })))],
          };
        },
      },
      {
        name: 'mem_penetration',
        description: 'Relationship depth at the latest month-end: share of members with checking, a loan, direct deposit and active digital banking, and products per member; overall with a year earlier, by branch, or by age band.',
        input: z.object({ focus: z.enum(['overall', 'branch', 'age']).default('overall') }).strict(),
        run: async (a: { focus: 'overall' | 'branch' | 'age' }, ctx) => {
          guard(ctx);
          const p = await svc.penetration(scope(ctx));
          const cols = [{ field: 'checking', headerName: 'Checking', type: 'text' as const }, { field: 'loan', headerName: 'A loan', type: 'text' as const }, { field: 'dd', headerName: 'Direct deposit', type: 'text' as const }, { field: 'digital', headerName: 'Digital, active', type: 'text' as const }, { field: 'ppm', headerName: 'Products per member', type: 'text' as const }];
          const row = (d: { members: number; checking: number; loan: number; directDeposit: number; digital: number; productsPerMember: number }) => ({ members: d.members, checking: p1(d.checking), loan: p1(d.loan), dd: p1(d.directDeposit), digital: p1(d.digital), ppm: d.productsPerMember.toFixed(2) });
          const n = p.now;
          const lead = `At ${p.label}, **${p1(n.checking)}** of members have checking, **${p1(n.loan)}** a loan and **${p1(n.directDeposit)}** direct deposit; **${p1(n.digital)}** are active on digital banking, and members hold **${n.productsPerMember.toFixed(2)}** products each${p.yearAgo ? ` (${p.yearAgo.productsPerMember.toFixed(2)} a year earlier)` : ''}.`;
          if (a.focus === 'age') {
            const lowLoan = [...p.ages].sort((x, y) => x.loan - y.loan)[0]!;
            const peak = [...p.ages].sort((x, y) => y.productsPerMember - x.productsPerMember)[0]!;
            const lowDigital = [...p.ages].sort((x, y) => x.digital - y.digital)[0]!;
            return {
              text: `${lead} Relationships are deepest at **${peak.band}** (${peak.productsPerMember.toFixed(2)} products). Only **${p1(lowLoan.loan)}** of members aged ${lowLoan.band} have a loan, and **${lowDigital.band}** is least digital (${p1(lowDigital.digital)}).`,
              blocks: [moduleTable(spec, 'Penetration by age band', ctx.runId, 'mem.penetration.age', [{ field: 'band', headerName: 'Age', type: 'text' }, { field: 'members', headerName: 'Members', type: 'count' }, ...cols], p.ages.map((x) => ({ band: x.band, ...row(x) })))],
            };
          }
          if (a.focus === 'branch') {
            const deep = [...p.branches].sort((x, y) => y.productsPerMember - x.productsPerMember)[0]!;
            const thin = [...p.branches].sort((x, y) => x.productsPerMember - y.productsPerMember)[0]!;
            return {
              text: `${lead}${p.branches.length > 1 ? ` **${deep.branch}** has the deepest relationships (${deep.productsPerMember.toFixed(2)} products) and **${thin.branch}** the thinnest (${thin.productsPerMember.toFixed(2)}).` : ''}`,
              blocks: [moduleTable(spec, 'Penetration by branch', ctx.runId, 'mem.penetration.branch', [{ field: 'branch', headerName: 'Branch', type: 'text' }, { field: 'members', headerName: 'Members', type: 'count' }, ...cols], p.branches.map((x) => ({ branch: x.branch, ...row(x) })))],
            };
          }
          return {
            text: lead,
            blocks: [moduleTable(spec, 'Member penetration', ctx.runId, 'mem.penetration', [{ field: 'when', headerName: 'Month-end', type: 'text' }, { field: 'members', headerName: 'Members', type: 'count' }, ...cols], [{ when: p.label, ...row(n) }, ...(p.yearAgo ? [{ when: 'A year earlier', ...row(p.yearAgo) }] : [])])],
            suggestions: ['Show penetration by age band', 'Which branches have the deepest relationships?'],
          };
        },
      },
      {
        name: 'mem_new_members',
        description: 'Members who joined in the last twelve months: how many already left, and the share of those staying with checking and a loan, and their products per member.',
        input: z.object({}).strict(),
        run: async (_: unknown, ctx) => {
          guard(ctx);
          const [nm, p] = await Promise.all([svc.newMembers(scope(ctx)), svc.penetration(scope(ctx))]);
          return {
            text: `**${n0(nm.joined)}** members joined in the last twelve months and **${n0(nm.left)}** (${p1(nm.leftPct)}) have already left. Of those staying, **${p1(nm.checking)}** have checking and **${p1(nm.loan)}** a loan, with **${nm.productsPerMember.toFixed(2)}** products each, against ${p.now.productsPerMember.toFixed(2)} for all members.${p.now.productsPerMember - nm.productsPerMember >= 0.15 ? ' Onboarding follow-ups in the first 90 days are where that gap closes.' : ' Those who stay are already about as deep as established members; the work is keeping the ones who leave early.'}`,
            blocks: [moduleTable(spec, 'New members, last 12 months', ctx.runId, 'mem.new', [{ field: 'item', headerName: 'Measure', type: 'text' }, { field: 'value', headerName: 'New members', type: 'text' }, { field: 'all', headerName: 'All members', type: 'text' }], [
              { item: 'Have checking', value: p1(nm.checking), all: p1(p.now.checking) },
              { item: 'Have a loan', value: p1(nm.loan), all: p1(p.now.loan) },
              { item: 'Products per member', value: nm.productsPerMember.toFixed(2), all: p.now.productsPerMember.toFixed(2) },
              { item: 'Already left', value: `${n0(nm.left)} of ${n0(nm.joined)}`, all: '—' },
            ])],
            suggestions: ['Show my overdue onboarding touch points'],
          };
        },
      },
    ],
  };
  return spec;
}
