// Member blocks (spec 8.24, 9.4): the member_card and the member_360, written by code from the DI
// Core profile. The model never fills these in; it only writes the talking points beside them.
import type { DiTake, ListBlock, Member360Block, MemberCardBlock, MemberScore } from '@dinext/block-schemas';
import { OPPORTUNITY_THRESHOLD, type MemberProfile, type PartyMatch, type Topic } from '@dinext/di-core';
import { newBlockId, TENANT_UTC_OFFSET } from './answer.ts';

export const RELATIONSHIP_AGENT = 'Relationship';

const longDate = (iso: string) => new Date(`${iso.slice(0, 10)}T00:00:00Z`).toLocaleDateString('en-US', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' });
const monthYear = (iso: string) => new Date(`${iso.slice(0, 10)}T00:00:00Z`).toLocaleDateString('en-US', { month: 'short', year: 'numeric', timeZone: 'UTC' });

const provenance = (runId: string | undefined, operations: string[]) => ({
  agent: RELATIONSHIP_AGENT,
  runId,
  operations,
  sources: [{ kind: 'table' as const, label: 'Relationship Manager', ref: 'table:cdm_party' }],
  purviewApplied: true,
});

const freshness = (p: MemberProfile) => ({ kind: 'nightly_build' as const, asOf: `${p.asOf.completedAt.replace(' ', 'T')}${TENANT_UTC_OFFSET}`, buildId: p.asOf.buildId });

export function scores(p: MemberProfile): MemberScore[] {
  const out: MemberScore[] = [{ id: 'attrition', label: 'Attrition risk', value: p.attrition.score, scale: 10, band: p.attrition.band, tone: p.attrition.band === 'High' ? 'danger' : p.attrition.band === 'Medium' ? 'warning' : 'success', modelDate: p.attrition.runDate }];
  const top = p.opportunities[0];
  if (top) out.push({ id: 'next_best', label: 'Next best product', value: top.likelihood, scale: 10, band: top.product, tone: 'accent', modelDate: p.attrition.runDate });
  return out;
}

function header(p: MemberProfile) {
  return {
    memberRef: p.token,
    person: p.person,
    displayName: p.name,
    maskedNumber: `…${p.last4}`,
    branch: p.branch,
    since: p.joined.slice(0, 4),
    badges: [
      { label: 'Primary', tone: 'neutral' as const },
      { label: p.segment, tone: 'info' as const },
      ...(p.isMember ? [] : [{ label: 'Non-member', tone: 'warning' as const }]),
    ],
  };
}

const depositChange = (p: MemberProfile) => {
  const before = p.deposits.reduce((s, a) => s + a.balance30d, 0);
  return before > 0 ? Math.round(((p.totals.deposits - before) / before) * 100) : 0;
};

/** The short card: who, what they hold, and the two scores with "Why?" (spec 8.24 wireframe). */
export function memberCard(p: MemberProfile, runId?: string, selected = true): MemberCardBlock {
  return {
    id: newBlockId('mbc'),
    type: 'member_card',
    version: '1.0.0',
    provenance: provenance(runId, ['relationship.profile.get']),
    freshness: freshness(p),
    a11y: { summary: `${p.name}, ${p.person} number ending ${p.last4}, ${p.branch}. ${p.totals.accounts} accounts. Attrition risk ${p.attrition.band.toLowerCase()}, ${p.attrition.score} of 10.` },
    data: {
      ...header(p),
      figures: [
        { label: 'Accounts', value: p.totals.accounts, unit: 'count' },
        { label: 'Deposits', value: p.totals.deposits, unit: 'currency' },
        { label: 'Loans', value: p.totals.loans, unit: 'currency' },
      ],
      scores: scores(p),
      nextBest: p.opportunities.slice(0, 2).map((o) => o.product),
      selected,
    },
  };
}

/** A pick-list card: only what a search may show before a record is opened (BE-RM-002). */
export function matchCard(h: PartyMatch, token: string, person: 'member' | 'customer', runId?: string): MemberCardBlock {
  return {
    id: newBlockId('mbc'),
    type: 'member_card',
    version: '1.0.0',
    provenance: { ...provenance(runId, ['relationship.party.search']), sources: [] },
    freshness: { kind: 'none' },
    data: {
      memberRef: token,
      person,
      displayName: h.name,
      maskedNumber: `…${h.last4}`,
      branch: h.branch,
      since: h.memberSince,
      badges: [],
      figures: [{ label: 'Products', value: h.products.length, unit: 'count' }],
      scores: [],
      nextBest: [],
      selected: false,
    },
  };
}

const lowerFirst = (s: string) => (/^[A-Z][a-z]/.test(s) ? s.charAt(0).toLowerCase() + s.slice(1) : s);

/** The first topic, in the fixed order of nextBestConversation, as a sentence. */
function topicLine(t: Topic, p: MemberProfile) {
  if (t.kind === 'pending_application') return `${p.firstName}’s ${lowerFirst(t.headline)}`;
  if (t.kind === 'retention_risk') {
    const main = p.attrition.factors.find((f) => f.weight > 0);
    return `${t.headline}${main ? `, mainly ${lowerFirst(main.label)}` : ''}`;
  }
  if (t.kind === 'product_opportunity') return `The best next product is ${t.refer?.product ?? t.headline.replace('Next best product: ', '')}`;
  return `${p.firstName} is ${lowerFirst(t.headline)}`;
}

/** What matters about this person today: the most serious alert, then what to raise first. */
export function memberTake(p: MemberProfile, topics: Topic[]): DiTake {
  const [first] = topics;
  const alert = p.alerts.find((a) => a.tone === 'danger') ?? p.alerts.find((a) => a.tone === 'warning');
  const parts = [...(alert && !(alert.code === 'attrition_high' && first?.kind === 'retention_risk') ? [alert.label] : []), ...(first ? [topicLine(first, p)] : [])];
  if (!parts.length) return { headline: `Nothing needs attention for ${p.firstName} today.` };
  return { headline: `${parts.join('. ')}.`, action: { label: 'Prepare me', ask: `Prepare me for my meeting with ${p.name}` } };
}

/** The full record, in the Relationship Dashboard's section order [BK p11] (FE-RM-001). */
export function member360(p: MemberProfile, runId?: string, take?: DiTake): Member360Block {
  const attrition = scores(p)[0]!;
  const change = depositChange(p);
  const lastLogin = p.lastLogin ? `Last login ${longDate(p.lastLogin)}` : undefined;
  const dd = p.directDeposit;
  const pending = p.applications.items.filter((a) => a.status === 'Pending');
  const alerts = [
    ...p.alerts.map((a) => ({ id: a.code, label: a.label, tone: a.tone })),
    ...pending.map((a, i) => ({ id: `app_pending_${i + 1}`, label: `${a.product} application pending`, tone: 'info' as const })),
  ];
  return {
    id: newBlockId('m36'),
    type: 'member_360',
    version: '1.0.0',
    title: `${p.person === 'customer' ? 'Customer' : 'Member'} 360`,
    provenance: provenance(runId, ['relationship.profile.get']),
    freshness: freshness(p),
    a11y: { summary: `${p.person === 'customer' ? 'Customer' : 'Member'} 360 for ${p.name}, ${p.branch}. ${alerts.length} alerts.` },
    data: {
      ...header(p),
      alerts,
      ...(take ? { take } : {}),
      sections: [
        {
          kind: 'overview',
          figures: [
            { label: 'Deposits', value: p.totals.deposits, unit: 'currency', ...(change ? { detail: `${change > 0 ? '+' : '−'}${Math.abs(change)}% in 30 days` } : {}) },
            { label: 'Loans', value: p.totals.loans, unit: 'currency' },
            { label: 'Products', value: p.totals.products, unit: 'count' },
            { label: 'Interactions', value: p.interactions.total, unit: 'count', detail: 'Last 12 months' },
          ],
          scores: scores(p),
          facts: [
            { label: 'Segment', value: p.segment },
            { label: `${p.person === 'customer' ? 'Customer' : 'Member'} since`, value: longDate(p.joined) },
            { label: 'Preferred contact', value: p.contact.preferred },
          ],
        },
        {
          kind: 'accounts',
          deposits: p.deposits.slice(0, 40).map((a) => ({ name: a.name, suffix: a.suffix, relationship: a.relationship, balance: a.balance, change30d: Math.round((a.balance - a.balance30d) * 100) / 100, fees30d: a.fees30d, rate: a.rate, ...(a.maturity ? { detail: `Matures ${longDate(a.maturity)}` } : {}) })),
          loans: p.loans.slice(0, 40).map((a) => ({ name: a.name, suffix: a.suffix, relationship: a.relationship, balance: a.balance, change30d: Math.round((a.balance - a.balance30d) * 100) / 100, fees30d: a.fees30d, rate: a.rate, ...(a.daysPastDue ? { detail: `${a.daysPastDue} days past due` } : {}) })),
        },
        {
          kind: 'digital',
          services: [
            ...p.digital.map((d) => ({ id: d.id, label: d.label, enrolled: d.enrolled, ...(d.id === 'mobile' && lastLogin ? { detail: lastLogin } : d.since ? { detail: `Since ${monthYear(d.since)}` } : {}) })),
            { id: 'direct_deposit', label: 'Direct deposit', enrolled: dd.status === 'active', ...(dd.status === 'stopped' && dd.changed ? { detail: `Stopped ${longDate(dd.changed)}` } : dd.status === 'active' && dd.changed ? { detail: `Since ${monthYear(dd.changed)}` } : {}) },
          ],
        },
        { kind: 'cross_sell', windows: p.growth, crossSell: p.crossSell, attrition },
        {
          kind: 'loan_apps',
          approved: p.applications.approved,
          denied: p.applications.denied,
          pending: p.applications.pending,
          items: p.applications.items.slice(0, 20).map((a) => ({ product: a.product, amount: a.amount, status: a.status, detail: a.detail, applied: a.applied })),
        },
        {
          kind: 'engagement',
          attrition,
          factors: p.attrition.factors.map((f) => ({ label: f.label, weight: f.weight })),
          facts: [
            { label: 'Direct deposit', value: dd.status === 'active' ? 'Active' : dd.status === 'stopped' ? `Stopped${dd.changed ? ` ${longDate(dd.changed)}` : ''}` : 'Not set up' },
            { label: 'Last digital login', value: p.lastLogin ? longDate(p.lastLogin) : 'Never' },
            { label: 'Model', value: `${p.attrition.model}, run ${longDate(p.attrition.runDate)}` },
          ],
        },
        {
          kind: 'opportunities',
          threshold: OPPORTUNITY_THRESHOLD,
          items: p.opportunities.slice(0, 10).map((o) => ({ suggestionId: o.suggestionId, product: o.product, likelihood: o.likelihood, reason: o.reason, referralTypeId: o.referralTypeId })),
          declined: p.declined.slice(0, 10),
        },
        { kind: 'interactions', total: p.interactions.total, items: p.interactions.items.map((i) => ({ at: i.at, channel: i.channel, kind: i.kind, summary: i.summary, by: i.by })) },
        // The source of rewards is not stated today [BK p11]; it comes from a configurable landing table (CA-29).
        { kind: 'rewards', status: 'not_configured', detail: 'Rewards are not set up for this institution yet.' },
        { kind: 'contact', preferred: p.contact.preferred, email: p.contact.email, phone: p.contact.phone },
        { kind: 'household', members: p.household.map((h) => ({ name: h.name, branch: h.branch, maskedNumber: h.last4 ? `…${h.last4}` : null, inPurview: h.inPurview })) },
      ],
    },
  };
}

/** Talking points: the model's wording, each with the code-written reason behind it (AI-AGT-152). */
export function talkingPoints(points: { text: string; topic: Topic }[], p: MemberProfile, runId: string): ListBlock {
  const icon = (k: Topic['kind']) => (k === 'pending_application' ? 'loan' : k === 'retention_risk' ? 'trend_down' : k === 'product_opportunity' ? 'referral' : k === 'open_issue' ? 'alert' : 'task');
  return {
    id: newBlockId('tlk'),
    type: 'list',
    version: '1.0.0',
    title: 'Suggested talking points',
    provenance: { ...provenance(runId, ['relationship.next_best_conversation']), sources: [{ kind: 'model', label: `${p.attrition.model}, run ${longDate(p.attrition.runDate)}` }] },
    freshness: freshness(p),
    data: {
      layout: 'list',
      items: points.map(({ text, topic }, i) => ({ id: `tp${i + 1}`, icon: icon(topic.kind), title: text, subtitle: topic.reason })),
    },
  };
}

/** "Why?" on a score: the main factors and the model's run date (FE-RM-002). */
export function scoreFactors(explained: { score: string; value: string; factors: { label: string; effect: string }[]; model: string; runDate: string }, p: MemberProfile, runId: string): ListBlock {
  return {
    id: newBlockId('why'),
    type: 'list',
    version: '1.0.0',
    title: `${explained.score}: ${explained.value}`,
    subtitle: `Model ${explained.model}, last run ${longDate(explained.runDate)}`,
    provenance: { ...provenance(runId, ['predictive.scores.explain']), sources: [{ kind: 'model', label: explained.model }] },
    freshness: freshness(p),
    data: { layout: 'list', items: explained.factors.map((f, i) => ({ id: `f${i + 1}`, icon: f.effect.startsWith('lowers') ? 'trend_down' : 'trend_up', title: f.label, subtitle: f.effect })) },
  };
}

/** Household members; those outside the purview are counted, never named (spec 20.7). */
export function householdList(p: MemberProfile, runId: string): ListBlock {
  const hidden = p.household.filter((h) => !h.inPurview).length;
  return {
    id: newBlockId('hhd'),
    type: 'list',
    version: '1.0.0',
    title: `${p.firstName}’s household`,
    provenance: provenance(runId, ['relationship.profile.get']),
    freshness: freshness(p),
    data: {
      layout: 'list',
      items: [
        ...p.household.filter((h) => h.inPurview).map((h, i) => ({ id: `h${i + 1}`, icon: 'member' as const, title: h.name!, subtitle: `${h.branch} · …${h.last4}` })),
        ...(hidden ? [{ id: 'hidden', icon: 'member' as const, title: `${hidden} more ${hidden === 1 ? 'person' : 'people'} outside your branches`, subtitle: 'Not shown because of your purview' }] : []),
      ],
    },
  };
}
