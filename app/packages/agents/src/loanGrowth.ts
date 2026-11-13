// Loan Growth (credit unions): members who pay an auto loan or HELOC to another lender, or have the equity
// and credit to qualify for one, found from their own accounts; and a measured outreach campaign that holds
// back a random control group, sends only the rest through the marketing platform, and reports the lift.
import { z } from 'zod';
import { CoreError, LG_RULES, LG_SEGMENTS, LoanGrowthService, type ApiService, type LgSegment } from '@dinext/di-core';
import { moduleTable, type ModuleContext, type ModuleSpec } from './moduleAgent.ts';

export const LOAN_GROWTH_REQUEST = /\b(?:at|with|from|to) (?:an?other|other|a different|outside) (?:lenders?|banks?|institutions?|credit unions?|financial institutions?)\b|\bloans? (?:held )?elsewhere\b|\bpaying (?:an? )?(?:auto|car|heloc|home equity)[^.?!]*\belsewhere\b|\bloan growth (?:campaign|outreach|prospects?|opportunit\w*)\b|\bequity and credit\b|\bqualify for (?:an? )?(?:auto|car|heloc|home equity)\b|\b(?:auto|car|heloc) refi\w*\b|\brefinanc\w* (?:their |members'? )?(?:auto|car|heloc)|\b(?:measured|controlled) (?:outreach|campaign)\b|\boutreach campaign\b[^.?!]*\bcontrol\b|\brefinance campaign\b|\b(?:auto|car) loans? (?:from|with|at) (?:ally|capital one|toyota|honda|chase|santander)\b|\bwho borrows elsewhere\b|\bwallet share\b/i;

export type LgQuestion = 'overview' | 'auto' | 'heloc' | 'equity' | 'credit' | 'lenders' | 'method';
export function lgQuestion(text: string): LgQuestion {
  const t = text.toLowerCase();
  if (/how (?:do|does) (?:you|di) (?:find|know|tell|work)|\bmethod|assum|how is (?:it|this) (?:found|worked out)/.test(t)) return 'method';
  if (/which lenders|what lenders|lenders? (?:are|do)|by lender/.test(t)) return 'lenders';
  const auto = /\bauto|\bcar\b/.test(t);
  const heloc = /heloc|home equity/.test(t);
  if (auto && heloc) return 'overview';
  if (/equity/.test(t) && !/elsewhere|another|other lender/.test(t)) return 'equity';
  if (heloc) return 'heloc';
  if (auto && /qualif|credit (?:and|to)|income/.test(t) && !/elsewhere|another|other lender/.test(t)) return 'credit';
  if (auto) return 'auto';
  return 'overview';
}

/** The segments a request asks for: auto, HELOC, elsewhere, qualifying, or all four. */
export function lgSegments(text: string): LgSegment[] {
  const t = text.toLowerCase();
  const auto = /\bauto|\bcar\b/.test(t);
  const heloc = /heloc|home equity/.test(t);
  const elsewhere = /elsewhere|another|other lender|outside|refinanc|\brefi\b/.test(t);
  const qualify = /qualif|equity and credit|equity to|credit to|could borrow/.test(t);
  const out: LgSegment[] = [];
  if (auto || !heloc) {
    if (elsewhere || !qualify) out.push('auto_elsewhere');
    if (qualify || !elsewhere) out.push('auto_credit');
  }
  if (heloc || !auto) {
    if (elsewhere || !qualify) out.push('heloc_elsewhere');
    if (qualify || !elsewhere) out.push('heloc_equity');
  }
  return out;
}

const NO_ACCESS = 'Loan growth campaigns aren’t part of your DI access.';
const text = (field: string, headerName: string) => ({ field, headerName, type: 'text' as const });
const count = (n: number) => Math.round(n).toLocaleString('en-US');
const mm = (n: number) => `$${(n / 1e6).toFixed(1)}M`;
const usd = (n: number) => `$${Math.round(n).toLocaleString('en-US')}`;
const p1 = (n: number) => `${n.toFixed(1)}%`;
const ORDER: LgSegment[] = ['auto_elsewhere', 'heloc_elsewhere', 'heloc_equity', 'auto_credit'];
/** "TOYOTA MOTOR CREDIT" as Toyota Motor Credit, keeping acronyms (GM, USA, PNC). */
const ACRONYMS = new Set(['gm', 'usa', 'pnc', 'td', 'bmo', 'us', 'na', 'fcu', 'cu']);
export const lenderName = (l: string) => l.toLowerCase().split(' ').map((w) => (ACRONYMS.has(w) ? w.toUpperCase() : w === 'of' ? w : w.charAt(0).toUpperCase() + w.slice(1))).join(' ');
const monthName = () => new Date().toLocaleString('en-US', { month: 'long', year: 'numeric', timeZone: 'UTC' });

export function loanGrowthModule(svc: LoanGrowthService, api: ApiService | null = null): ModuleSpec {
  const need = (ctx: ModuleContext) => {
    if (!ctx.modules.includes('loangrowth')) throw new CoreError('NO_ACCESS', NO_ACCESS);
  };
  const sources: ModuleSpec['sources'] = [
    { kind: 'table', label: 'Checking transactions, from the core', ref: 'table:cdm_transaction' },
    { kind: 'table', label: 'Loans and members', ref: 'table:cdm_loan' },
    { kind: 'table', label: 'Loan growth campaigns', ref: 'table:lg_campaign' },
  ];
  /** What each segment is, in a sentence. */
  const describe = (x: Awaited<ReturnType<LoanGrowthService['prospects']>>, segs: LgSegment[]) => {
    const g = (k: LgSegment) => x.segments.find((s) => s.segment === k)!;
    const bits: string[] = [];
    if (segs.includes('auto_elsewhere')) {
      const s = g('auto_elsewhere');
      bits.push(`**${count(s.members)}** pay an auto loan to another lender (about ${mm(s.estBalance)} between them; at our ${x.rates.Auto.toFixed(2)}% they’d save about $${Math.round(s.estMonthlySaving ?? 0)} a month on average, ${usd((s.estMonthlySaving ?? 0) * 38)} over the loan)`);
    }
    if (segs.includes('heloc_elsewhere')) {
      const s = g('heloc_elsewhere');
      bits.push(`**${count(s.members)}** pay a HELOC elsewhere (about ${mm(s.estBalance)}; about $${Math.round(s.estMonthlySaving ?? 0)} a month less at our ${x.rates.HELOC.toFixed(2)}%)`);
    }
    if (segs.includes('heloc_equity')) {
      const s = g('heloc_equity');
      bits.push(`**${count(s.members)}** have the home equity and a ${LG_RULES.minScore}+ score for a HELOC but none anywhere (${mm(s.lines)} in lines they could draw)`);
    }
    if (segs.includes('auto_credit')) {
      const s = g('auto_credit');
      bits.push(`**${count(s.members)}** have the credit and direct-deposit income for an auto loan but no auto loan anywhere`);
    }
    return bits.length > 1 ? `${bits.slice(0, -1).join(', ')} and ${bits.at(-1)}` : (bits[0] ?? '');
  };
  const left = (x: Awaited<ReturnType<LoanGrowthService['prospects']>>) => `Left out: ${count(x.excluded.delinquent)} behind on a loan with us, ${x.excluded.deceased ? `${count(x.excluded.deceased)} who have died, ` : ''}${count(x.excluded.optOut)} who opted out of marketing and ${count(x.excluded.recentContact)} contacted in the last 30 days.`;
  const lastResult = async () => {
    const sent = (await svc.campaigns()).filter((c) => c.status === 'Sent').at(-1);
    if (!sent) return null;
    return svc.results(sent.id);
  };
  const resultLine = (r: NonNullable<Awaited<ReturnType<typeof lastResult>>>) =>
    `${r.campaign.name} lifted take-up **${r.total.liftPts.toFixed(1)} points** over its control group (${p1(r.total.treatmentRatePct)} of those contacted against ${p1(r.total.controlRatePct)} held back)${r.total.significant ? '' : ', though the difference could still be chance'}: about **${count(r.total.incremental)} loans** and ${mm(r.total.incrementalDollars)} it caused`;

  const spec: ModuleSpec = {
    id: 'loangrowth',
    prefix: 'lg',
    agent: 'Loan Growth',
    request: LOAN_GROWTH_REQUEST,
    noAccess: NO_ACCESS,
    sources,
    prompt: ({ tenant, user, title }) => `You are the Loan Growth agent inside Kinective Data Intelligence (DI) for ${tenant}. ${user} (${title}) grows lending to members. DI finds members who pay an auto loan or a HELOC to another lender from recurring ACH payments on their checking accounts, and members with the home equity and credit for a HELOC or the credit and income for an auto loan. Outreach is measured: a random control group in each segment is held back and never contacted, so the lift is what the campaign caused.

- lg_find, with question overview, auto, heloc, equity, credit, lenders or method: who could borrow and why.
- lg_prepare: prepare a measured outreach campaign (segments, holdout_pct, default 10). It needs approval and sends nothing.
- lg_send: send a prepared campaign's contacted group to the marketing platform. High risk: contact details leave DI. The control group never goes.
- lg_results: a campaign's lift over its control group.`,
    plan: (t) => {
      const s = t.toLowerCase();
      if (/\b(?:send|launch|start|push)\b/.test(s) && !/\bprepare|build|find\b/.test(s)) return { tool: 'lg_send', args: {} };
      if (/\b(?:lift|results?|how did|did it work|work(?:ed)?\b|measure (?:it|the)|caused|paid off)\b/.test(s) && !/\bprepare|build|set up|create\b/.test(s)) return { tool: 'lg_results', args: {} };
      if (/\b(?:prepare|build|set up|create|plan|design|run)\b[^.?!]*\b(?:campaign|outreach)\b|\b(?:campaign|outreach)\b[^.?!]*\bcontrol group\b/.test(s)) {
        const pct = /(\d{1,2})\s*%\s*(?:control|hold|held)/.exec(s) ?? /(?:control|holdout|hold back|held back)[^.?!\d]{0,20}(\d{1,2})\s*%/.exec(s);
        return { tool: 'lg_prepare', args: { segments: lgSegments(t), ...(pct ? { holdout_pct: Number(pct[1]) } : {}) } };
      }
      return { tool: 'lg_find', args: { question: lgQuestion(t) } };
    },
    tools: [
      {
        name: 'lg_find',
        description: 'Members who pay an auto loan or HELOC to another lender, or have the equity and credit to qualify for one, by segment: how many, the estimated balances and savings, the lenders, and who was left out and why.',
        input: z.object({ question: z.enum(['overview', 'auto', 'heloc', 'equity', 'credit', 'lenders', 'method']).optional() }).strict(),
        run: async (a: { question?: LgQuestion }, ctx) => {
          need(ctx);
          if (a.question === 'method') return { text: `How DI finds them:\n\n${svc.assumptions().map(([k, v]) => `- **${k}:** ${v}`).join('\n')}` };
          const x = await svc.prospects(ctx);
          const q = a.question ?? 'overview';
          const segs: LgSegment[] = q === 'auto' ? ['auto_elsewhere'] : q === 'heloc' ? ['heloc_elsewhere'] : q === 'equity' ? ['heloc_equity'] : q === 'credit' ? ['auto_credit'] : ORDER;
          const total = x.segments.filter((s) => segs.includes(s.segment)).reduce((t, s) => t + s.members, 0);
          const lenders = x.lenders.slice(0, 4).map((l) => `${lenderName(l.lender)} (${count(l.members)})`).join(', ');
          const r = await lastResult().catch(() => null);
          const parts = [
            `**${count(total)} members** could borrow ${q === 'overview' ? 'more ' : ''}from us: ${describe(x, segs)}.`,
            q === 'lenders' || q === 'overview' || q === 'auto' ? `The lenders they pay most: ${lenders}. ${count(x.cardIssuersIgnored)} card payments were set aside: they change with the statement, so they aren’t loans.` : '',
            q === 'equity' || q === 'overview' ? `Another ${count(x.homeownersElsewhere)} members pay a mortgage elsewhere; DI needs a home value feed before it can size their equity.` : '',
            left(x),
            r ? `Measured outreach works here: ${resultLine(r)}.` : '',
          ].filter(Boolean);
          const t = (title: string, op: string, cols: ReturnType<typeof text>[], rows: Record<string, string>[]) => moduleTable(spec, title, ctx.runId, op, cols, rows);
          const segTable = t('Who could borrow from us', 'lg.segments', [text('segment', 'Segment'), text('members', 'Members'), text('balance', 'Estimated balance elsewhere'), text('saving', 'Saving a month, average'), text('lines', 'Lines they qualify for'), text('product', 'Offer')], x.segments.filter((s) => segs.includes(s.segment)).map((s) => ({ segment: s.label, members: count(s.members), balance: s.estBalance ? mm(s.estBalance) : '—', saving: s.estMonthlySaving !== null ? usd(s.estMonthlySaving) : '—', lines: s.lines ? mm(s.lines) : '—', product: s.segment === 'auto_elsewhere' ? `Auto refinance at ${x.rates.Auto.toFixed(2)}%` : s.segment === 'heloc_elsewhere' ? `HELOC refinance at ${x.rates.HELOC.toFixed(2)}%` : s.segment === 'heloc_equity' ? `HELOC at ${x.rates.HELOC.toFixed(2)}%` : `Auto loan at ${x.rates.Auto.toFixed(2)}%` })));
          const top = x.prospects.filter((p) => segs.includes(p.segment)).sort((p, q2) => (q2.estMonthlySaving ?? -1) - (p.estMonthlySaving ?? -1) || (q2.line ?? 0) - (p.line ?? 0)).slice(0, 12);
          const sample = t('Who stands to gain most', 'lg.members', [text('member', 'Member'), text('segment', 'Segment'), text('lender', 'Pays'), text('payment', 'Payment a month'), text('balance', 'Estimated balance'), text('gain', 'Saving a month, or line')], top.map((p) => ({ member: p.name, segment: LG_SEGMENTS[p.segment].short, lender: p.lender ? lenderName(p.lender) : '—', payment: p.monthlyPayment ? usd(p.monthlyPayment) : '—', balance: p.estBalance ? usd(p.estBalance) : '—', gain: p.estMonthlySaving !== null ? `${usd(p.estMonthlySaving)} a month` : p.line ? `${usd(p.line)} line` : '—' })));
          const lenderTable = t('Lenders our members pay', 'lg.lenders', [text('lender', 'Lender'), text('members', 'Members')], x.lenders.map((l) => ({ lender: lenderName(l.lender), members: count(l.members) })));
          return {
            text: parts.join(' '),
            blocks: q === 'lenders' ? [lenderTable, segTable] : [segTable, sample, ...(q === 'overview' ? [lenderTable] : [])],
            sources,
            suggestions: ['Prepare a measured outreach campaign with a 10% control group', 'Which lenders do our members pay?', 'How did the July auto refinance campaign do?', 'How does DI find loans elsewhere?'],
          };
        },
      },
      {
        name: 'lg_prepare',
        description: 'Prepare a measured outreach campaign: the members in the chosen segments, split at random within each segment into a contacted group and a control group that is never contacted. Saving it needs approval; nothing is sent.',
        input: z.object({ segments: z.array(z.enum(['auto_elsewhere', 'heloc_elsewhere', 'heloc_equity', 'auto_credit'])).min(1).optional(), holdout_pct: z.number().min(5).max(50).optional(), name: z.string().min(3).max(80).optional() }).strict(),
        run: async (a: { segments?: LgSegment[]; holdout_pct?: number; name?: string }, ctx) => {
          need(ctx);
          const segs = ORDER.filter((s) => (a.segments ?? ORDER).includes(s));
          const holdout = a.holdout_pct ?? 10;
          const x = await svc.prospects(ctx);
          const chosen = x.prospects.filter((p) => segs.includes(p.segment));
          if (!chosen.length) return { text: 'No member fits those segments after the exclusions, so there’s nothing to send.' };
          const name = a.name ?? (segs.length === ORDER.length ? `Loan growth outreach, ${monthName()}` : `Loan growth: ${segs.map((s) => LG_SEGMENTS[s].short).join(' and ')}, ${monthName()}`).slice(0, 80);
          const split = LoanGrowthService.split(chosen, holdout, name);
          const arm = (seg: LgSegment, which: 'treatment' | 'control') => split.filter((p) => p.segment === seg && p.arm === which).length;
          const treatment = split.filter((p) => p.arm === 'treatment').length;
          const r = await lastResult().catch(() => null);
          // Each arm needs enough members for a lift of a few points to show: say so when a segment is small.
          const small = segs.filter((s) => arm(s, 'control') < 100);
          return {
            change: {
              summary: `Prepare “${name}”: ${count(treatment)} to contact, ${count(split.length - treatment)} held back`,
              changes: [
                ...segs.map((s) => ({ label: LG_SEGMENTS[s].label, before: '—', after: `${count(arm(s, 'treatment'))} contacted, ${count(arm(s, 'control'))} held back` })),
                { label: 'Control group', before: '—', after: `${holdout}% of each segment, chosen at random, never contacted` },
                { label: 'Left out first', before: '—', after: `${count(x.excluded.delinquent)} behind on a loan, ${x.excluded.deceased ? `${count(x.excluded.deceased)} who have died, ` : ''}${count(x.excluded.optOut)} opted out, ${count(x.excluded.recentContact)} contacted recently` },
                { label: 'Sent', before: '—', after: 'Nothing yet. Sending the contacted group to the marketing platform is a separate approval.' },
              ],
              text: `**${count(chosen.length)} members** could borrow from us: ${describe(x, segs)}. ${left(x)} I’ll hold back a random **${holdout}%** of each segment as a control group, never contacted, and contact the other **${count(treatment)}**, so in 60 to 90 days DI can say what the outreach caused: new loans with us, and payments to the other lender that stop.${small.length ? ` ${small.map((s) => LG_SEGMENTS[s].short).join(' and ')} ${small.length === 1 ? 'has' : 'have'} under 100 in the control group, so a small lift there may not be clear.` : ''}${r ? ` For comparison, ${resultLine(r)}.` : ''} Built from our own transaction data, not a credit report, so it isn’t a prescreened offer under the FCRA; the criteria should still go through fair lending review.`,
              done: `Prepared “${name}”. Nothing has been sent: say “Send the loan growth campaign” to send the ${count(treatment)} contacted members to the marketing platform.`,
              risk: 'medium',
              records: split.length,
              apply: { name, segments: segs, holdoutPct: holdout, members: split.map((p) => ({ partyId: p.partyId, segment: p.segment, arm: p.arm, lender: p.lender, saving: p.estMonthlySaving })) },
            },
          };
        },
        apply: async (p: Parameters<LoanGrowthService['record']>[0], meta, ctx) => {
          const id = await svc.record(p, { approvalId: meta.approvalId, by: ctx.user.name });
          return { text: `Prepared campaign ${id}, “${p.name}”. Nothing has been sent.`, suggestions: ['Send the loan growth campaign'] };
        },
      },
      {
        name: 'lg_send',
        description: 'Send a prepared loan growth campaign’s contacted group to the connected marketing platform and start its email. The control group is never sent. Members go as a reference, first name and email. High risk.',
        input: z.object({ campaign_id: z.number().int().optional() }).strict(),
        run: async (a: { campaign_id?: number }, ctx) => {
          need(ctx);
          const list = await svc.campaigns();
          const c = a.campaign_id ? list.find((x) => x.id === a.campaign_id) : list.filter((x) => x.status === 'Prepared').at(-1);
          if (!c) return { text: 'There’s no prepared loan growth campaign to send. Ask me to prepare one first, for example “Prepare a measured outreach campaign for members with auto loans elsewhere”.' };
          if (c.status === 'Sent') return { text: `“${c.name}” was already sent on ${c.sentOn}.` };
          const platform = api ? await api.marketing() : null;
          if (!platform) throw new CoreError('NOT_FOUND', 'No marketing platform is connected that can take a list. An Integrations administrator connects one under Vendor API on Integrations.');
          const members = await svc.treatmentMembers(c.id);
          return {
            change: {
              summary: `Send ${count(members.length)} members of “${c.name}” to ${platform.name}`,
              changes: [
                { label: 'Contacted group', before: '—', after: `${count(members.length)} members with an email` },
                { label: 'Control group', before: '—', after: `${count(c.control)} members, kept in DI and never sent` },
                { label: 'Fields', before: '—', after: 'A reference DI can match back, first name, email. No member number, balance or lender.' },
                { label: 'To', before: '—', after: `${platform.name}, ${platform.baseUrl}` },
              ],
              text: `I’ll send the **${count(members.length)} contacted members** of “${c.name}” to **${platform.name}** and start the email. Their contact details leave DI, so this is high risk; the ${count(c.control)} in the control group stay here. DI then watches for new loans and for payments to the other lender that stop.`,
              done: `Sent “${c.name}” to ${platform.name}.`,
              risk: 'high',
              records: members.length,
              external: members.length,
              apply: { campaignId: c.id, connectionId: platform.connectionId, expected: members.length },
            },
          };
        },
        apply: async (p: { campaignId: number; connectionId: number; expected: number }, meta, ctx) => {
          if (!api) throw new CoreError('INVALID', 'API connections aren’t set up in this environment.');
          const c = (await svc.campaigns()).find((x) => x.id === p.campaignId)!;
          const members = await svc.treatmentMembers(p.campaignId);
          if (members.length !== p.expected) throw new CoreError('INVALID', `The contacted group changed since you approved it (${count(p.expected)} then, ${count(members.length)} now), so nothing was sent.`);
          const r = await api.pushAudience({ connectionId: p.connectionId, audienceName: `${c.name} (contacted)`.slice(0, 80), category: 'Loan growth', campaignName: c.name, members }, { userId: ctx.user.id, name: ctx.user.name }, { approvalId: meta.approvalId, runId: ctx.runId });
          await svc.markSent(p.campaignId, r.pushId);
          return { text: `Sent **${count(r.accepted)} members** to ${r.connection} and started “${c.name}”. The ${count(c.control)} in the control group weren’t sent. Ask me in 60 to 90 days what it caused.`, suggestions: ['How did the loan growth campaign do?'] };
        },
      },
      {
        name: 'lg_results',
        description: 'A loan growth campaign’s results: the share of contacted members and of the control group who opened the product with the credit union, the lift, whether it is more than chance, the loans and dollars it caused and the loans that moved from other lenders.',
        input: z.object({ campaign_id: z.number().int().optional() }).strict(),
        run: async (a: { campaign_id?: number }, ctx) => {
          need(ctx);
          const list = (await svc.campaigns()).filter((c) => c.status === 'Sent');
          const c = a.campaign_id ? list.find((x) => x.id === a.campaign_id) : list.at(-1);
          if (!c) return { text: 'No loan growth campaign has been sent yet, so there’s nothing to measure.' };
          const r = await svc.results(c.id);
          const t = r.total;
          const young = (Date.parse(new Date().toISOString().slice(0, 10)) - Date.parse(r.since)) / 86_400_000 < 45;
          return {
            text: `“${c.name}” went to ${count(t.treatment)} members on ${r.since}, with ${count(t.control)} held back. Since then **${p1(t.treatmentRatePct)}** of those contacted opened ${c.segments.every((s) => s.startsWith('auto')) ? 'an auto loan' : 'the loan'} with us, against **${p1(t.controlRatePct)}** of the control group: a lift of **${t.liftPts.toFixed(1)} points**${t.significant ? ', more than chance would explain' : ', which could still be chance'}. That is about **${count(t.incremental)} loans** and **${mm(t.incrementalDollars)}** the outreach caused, worth about ${usd(t.value)} in contribution over their life. ${count(t.moved)} of the new loans moved from another lender: the payments to it stopped.${young ? ' It’s early: most responses come within 60 to 90 days.' : ''}`,
            blocks: [moduleTable(spec, `${c.name}: contacted against held back`, ctx.runId, 'lg.results', [text('segment', 'Segment'), text('contacted', 'Contacted'), text('rate', 'Took it up'), text('control', 'Held back'), text('controlRate', 'Took it up anyway'), text('lift', 'Lift'), text('caused', 'Loans caused')], [...r.bySegment, ...(r.bySegment.length > 1 ? [{ segment: 'all', label: 'All', ...t }] : [])].map((s) => ({ segment: s.label, contacted: count(s.treatment), rate: p1(s.treatmentRatePct), control: count(s.control), controlRate: p1(s.controlRatePct), lift: `${s.liftPts >= 0 ? '+' : ''}${s.liftPts.toFixed(1)} pts${s.significant ? '' : ' (not clear)'}`, caused: count(s.incremental) })))],
            sources,
            suggestions: ['Prepare a measured outreach campaign with a 10% control group', 'Who could borrow from us?'],
          };
        },
      },
    ],
  };
  return spec;
}
