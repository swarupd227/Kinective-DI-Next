// Member blocks (spec 8.24, 9.4): the member_card and the member_360, written by code from the DI
// Core profile. The model never fills these in; it only writes the talking points beside them.
import type { DiTake, ListBlock, Member360Block, MemberCardBlock, MemberScore, TextBlock } from '@dinext/block-schemas';
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
  return { headline: `${parts.join('. ')}.`, action: { label: 'Prepare me for the meeting', ask: `Prepare me for my meeting with ${p.name}${p.last4 ? `, ending ${p.last4}` : ''}` } };
}

/** The full record, in the Relationship Dashboard's section order [BK p11] (FE-RM-001). */
/** An account's detail line, with who else is on it (joint owners, co-borrowers, signers, beneficiaries). */
function ownersDetail(p: MemberProfile, suffix: string, base: string | null): { detail?: string } {
  const others = p.coOwners.filter((c) => c.suffix === suffix);
  const who = others.length ? others.map((c) => `${c.role === 'Beneficiary' ? 'beneficiary' : c.role === 'Authorized signer' ? 'signer' : 'with'} ${c.name}`).join(', ') : '';
  const text = [base, who && `${who.charAt(0).toUpperCase()}${who.slice(1)}`].filter(Boolean).join('. ');
  return text ? { detail: text.slice(0, 80) } : {};
}

/** What to say under a digital service: 90-day use where it's loaded, else when it started. */
function digitalDetail(d: MemberProfile['digital'][number], u: MemberProfile['usage'], lastLogin: string | undefined): string | null {
  if (u && d.enrolled) {
    if (d.id === 'mobile') return `${u.mobileLogins90d} logins in 90 days${lastLogin ? `; ${lastLogin.toLowerCase()}` : ''}`;
    if (d.id === 'online_banking') return `${u.logins90d} logins in 90 days`;
    if (d.id === 'estatements') return `${u.estatementAccounts} of ${u.depositAccounts} deposit accounts`;
    if (d.id === 'bill_pay') return `${u.billPayments90d} payments in 90 days`;
    if (d.id === 'mobile_deposit') return `${u.mobileDeposits90d} deposits in 90 days`;
  }
  if (d.id === 'mobile' && lastLogin) return lastLogin;
  return d.since ? `Since ${monthYear(d.since)}` : null;
}

export function member360(p: MemberProfile, runId?: string, take?: DiTake): Member360Block {
  const attrition = scores(p)[0]!;
  const change = depositChange(p);
  const lastLogin = p.lastLogin ? `Last login ${longDate(p.lastLogin)}` : undefined;
  const dd = p.directDeposit;
  const pending = p.applications.items.filter((a) => a.status === 'Pending');
  const alerts = [
    ...p.alerts.map((a) => ({ id: a.code, label: a.label, tone: a.tone })),
    ...pending.map((a, i) => ({ id: `app_pending_${i + 1}`, label: `${a.product} application pending`, tone: 'info' as const })),
    ...p.notes.filter((n) => n.kind === 'Warning').map((n, i) => ({ id: `warn_${i + 1}`, label: `${n.code ?? 'Warning'}: ${n.text}`.slice(0, 120), tone: 'danger' as const })),
  ].slice(0, 12);
  const survey = p.surveys[0];
  const u = p.usage;
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
            { label: 'Born', value: `${longDate(p.identity.birthDate)} (age ${p.identity.age}, ${p.identity.generation})` },
            { label: 'Credit score', value: p.creditScore ? `${p.creditScore.score}, from ${p.creditScore.from}, ${longDate(p.creditScore.asOf)}` : 'None on file' },
            { label: 'Latest survey', value: survey ? `${survey.score} of 10, ${survey.kind.toLowerCase()}, ${longDate(survey.date)}${survey.comment ? `: “${survey.comment}”` : ''}`.slice(0, 120) : 'None answered' },
            { label: 'Identity last verified', value: p.lastVerification ? `${longDate(p.lastVerification.at.slice(0, 10))}, ${p.lastVerification.channel.toLowerCase()}, ${p.lastVerification.result.toLowerCase()} (${p.lastVerification.by})` : 'Not verified in DI' },
            { label: 'Charged off', value: p.chargeOffs.count ? `${p.chargeOffs.count} ${p.chargeOffs.count === 1 ? 'loan' : 'loans'}: ${p.chargeOffs.items.map((x) => `${x.product}, ${longDate(x.chargedOff)}`).join('; ')}`.slice(0, 120) : 'None' },
          ],
        },
        {
          kind: 'accounts',
          deposits: [
            ...p.deposits.slice(0, 40).map((a) => ({ name: a.name, suffix: a.suffix, relationship: a.relationship, balance: a.balance, change30d: Math.round((a.balance - a.balance30d) * 100) / 100, fees30d: a.fees30d, rate: a.rate, ...(ownersDetail(p, a.suffix, a.maturity ? `Matures ${longDate(a.maturity)}` : null)) })),
            ...p.sharedAccounts.filter((s) => s.kind === 'deposit').slice(0, Math.max(0, 40 - p.deposits.length)).map((s) => ({ name: s.name, suffix: s.suffix, relationship: s.role === 'Authorized signer' ? ('Authorized' as const) : ('Joint' as const), balance: s.balance, change30d: 0, fees30d: 0, detail: `${s.role}; ${s.primary}’s account`.slice(0, 80) })),
          ],
          loans: [
            ...p.loans.slice(0, 40).map((a) => ({ name: a.name, suffix: a.suffix, relationship: a.relationship, balance: a.balance, change30d: Math.round((a.balance - a.balance30d) * 100) / 100, fees30d: a.fees30d, rate: a.rate, ...(ownersDetail(p, a.suffix, a.daysPastDue ? `${a.daysPastDue} days past due` : null)) })),
            ...p.sharedAccounts.filter((s) => s.kind === 'loan').slice(0, Math.max(0, 40 - p.loans.length)).map((s) => ({ name: s.name, suffix: s.suffix, relationship: 'Joint' as const, balance: s.balance, change30d: 0, fees30d: 0, detail: `Co-borrower; ${s.primary}’s loan`.slice(0, 80) })),
          ],
        },
        {
          kind: 'digital',
          services: [
            ...p.digital.map((d) => ({ id: d.id, label: d.label, enrolled: d.enrolled, ...(digitalDetail(d, u, lastLogin) ? { detail: digitalDetail(d, u, lastLogin)! } : {}) })),
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
            ...(u ? [{ label: 'Logins, 90 days', value: `${u.logins90d} (${u.mobileLogins90d} on mobile)` }, { label: 'Fees, 90 days', value: `$${u.fees90d.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}` }] : []),
            { label: 'Model', value: `${p.attrition.model}, run ${longDate(p.attrition.runDate)}` },
          ],
        },
        {
          kind: 'opportunities',
          threshold: OPPORTUNITY_THRESHOLD,
          items: p.opportunities.slice(0, 10).map((o) => ({ suggestionId: o.suggestionId, product: o.product, likelihood: o.likelihood, reason: o.reason, referralTypeId: o.referralTypeId })),
          declined: p.declined.slice(0, 10),
        },
        { kind: 'workflows', items: p.workflows.slice(0, 30) },
        {
          kind: 'about',
          employment: p.about
            ? [
                { label: 'Employer', value: p.about.employer ?? '—' },
                ...(p.about.occupation ? [{ label: 'Occupation', value: p.about.occupation }] : []),
                ...(p.about.yearsEmployed !== null ? [{ label: 'Years there', value: String(p.about.yearsEmployed) }] : []),
                ...(p.about.incomeBand ? [{ label: 'Income', value: p.about.incomeBand }] : []),
              ]
            : [],
          interests: p.about?.interests.slice(0, 10) ?? [],
          lifeEvents: p.about?.lifeEvents.slice(0, 10) ?? [],
          goals: p.about?.goals.slice(0, 8) ?? [],
        },
        { kind: 'interactions', total: p.interactions.total, items: p.interactions.items.map((i) => ({ at: i.at, channel: i.channel, kind: i.kind, summary: i.summary, by: i.by })) },
        { kind: 'cards', items: p.cards.slice(0, 12).map((k) => ({ kind: k.kind, suffix: k.last4, status: k.status, opened: k.opened, activated: k.activated, closed: k.closed, detail: k.kind === 'Debit' ? `On checking …${k.account}` : `Card account …${k.account}` })) },
        p.transactions
          ? { kind: 'transactions', total90d: p.transactions.total90d, items: p.transactions.items }
          : { kind: 'transactions', total90d: 0, items: [], note: 'Transactions from the core aren’t loaded for this institution yet.' },
        { kind: 'notes', items: p.notes.slice(0, 12) },
        // Rewards come from the program's landing tables (CA-29); an institution without them shows it isn't set up.
        p.rewards === undefined
          ? { kind: 'rewards', status: 'not_configured', detail: 'Rewards are not set up for this institution yet.' }
          : p.rewards === null
            ? { kind: 'rewards', status: 'not_enrolled' }
            : { kind: 'rewards', status: 'enrolled', tier: p.rewards.tier, points: p.rewards.points, enrolled: p.rewards.enrolled, ledger: p.rewards.ledger.slice(0, 12) },
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
    provenance: { ...provenance(runId, ['relationship.next_best_conversation']), sources: [{ kind: 'model', label: `Attrition score, ${longDate(p.attrition.runDate)}` }] },
    freshness: freshness(p),
    data: {
      layout: 'list',
      items: points.map(({ text, topic }, i) => ({ id: `tp${i + 1}`, icon: icon(topic.kind), title: text, subtitle: topic.reason })),
    },
  };
}

const money = (n: number) => `${n < 0 ? '−' : ''}$${Math.abs(Math.round(n)).toLocaleString('en-US')}`;
const sentence = (s: string) => s.charAt(0).toUpperCase() + s.slice(1).replace(/[.;]\s*$/, '');
const md = (s: string) => s.replace(/([*_`[\]|<>])/g, '\\$1');

/**
 * The meeting brief: one page a person can read in the minute before a meeting. Every line is written
 * by code from the record, so nothing in it is a guess; the talking points beside it are the model's
 * wording of the same topics.
 */
export function meetingBrief(p: MemberProfile, topics: Topic[], points: string[], runId: string): TextBlock {
  const person = p.person === 'customer' ? 'Customer' : 'Member';
  const change30 = p.totals.deposits - p.deposits.reduce((s, a) => s + a.balance30d, 0);
  const dd = p.directDeposit.status === 'stopped' ? `stopped ${p.directDeposit.changed ? longDate(p.directDeposit.changed) : ''}`.trim() : p.directDeposit.status === 'active' ? 'active' : 'none on file';
  const login = p.lastLogin ? longDate(p.lastLogin) : 'never';
  const lines: string[] = [];
  const section = (title: string, rows: string[]) => {
    if (rows.length) lines.push(`### ${title}`, ...rows, '');
  };

  lines.push(`**${md(p.name)}** · ${person} …${p.last4} · ${md(p.branch)} · ${md(p.segment)} · since ${monthYear(p.joined)} · prefers ${md(p.contact.preferred.toLowerCase())}`, '');
  section('At a glance', [
    `- **Deposits** ${money(p.totals.deposits)}${change30 ? ` (${change30 > 0 ? 'up' : 'down'} ${money(Math.abs(change30))} in 30 days)` : ''} · **Loans** ${money(p.totals.loans)} · **Products** ${p.totals.products}`,
    `- **Attrition risk** ${p.attrition.score} of 10 (${p.attrition.band}) · **Direct deposit** ${dd} · **Last online login** ${login}`,
  ]);
  section('Accounts', [...p.deposits, ...p.loans].slice(0, 6).map((a) => {
    const moved = a.balance - a.balance30d;
    return `- ${md(a.name)} …${a.suffix}: ${money(a.balance)}${Math.abs(moved) >= 1 ? `, ${moved > 0 ? 'up' : 'down'} ${money(Math.abs(moved))} in 30 days` : ''}${a.fees30d ? `, ${money(a.fees30d)} in fees` : ''}${a.relationship !== 'Primary' ? ` (${a.relationship.toLowerCase()})` : ''}`;
  }));
  const pending = p.applications.items.filter((a) => a.status === 'Pending');
  section('Open items', [
    ...pending.map((a) => `- ${md(a.product)} application for ${money(a.amount)}, applied ${longDate(a.applied)}: ${md(a.detail.toLowerCase())}`),
    ...topics.filter((t) => t.kind === 'open_issue').map((t) => `- ${md(sentence(t.headline))}`),
  ]);
  const denied = p.applications.items.filter((a) => a.status === 'Denied').slice(0, 2);
  section('What has changed', [
    ...(change30 < 0 ? [`- Deposits fell ${money(Math.abs(change30))} in the last 30 days.`] : change30 > 0 ? [`- Deposits grew ${money(change30)} in the last 30 days.`] : []),
    ...(p.directDeposit.status === 'stopped' ? [`- Direct deposit stopped${p.directDeposit.changed ? ` on ${longDate(p.directDeposit.changed)}` : ''}.`] : []),
    ...(p.lastLogin ? [] : ['- Has never logged in online or on mobile.']),
    ...denied.map((a) => `- ${md(a.product)} application for ${money(a.amount)} was denied${a.decided ? ` on ${longDate(a.decided)}` : ''}.`),
  ]);
  section('Why they might leave', p.attrition.factors.filter((f) => f.weight > 0).slice(0, 4).map((f) => `- ${md(sentence(f.label))} (adds ${f.weight})`));
  section('What to offer', [
    ...p.opportunities.filter((o) => o.likelihood >= OPPORTUNITY_THRESHOLD).slice(0, 3).map((o) => `- **${md(o.product)}**, ${o.likelihood} of 10: ${md(o.reason)}`),
    ...p.declined.map((d) => `- Don't offer **${md(d.product)}**: declined, hidden until ${longDate(d.until)}`),
  ]);
  section('Recent contact', p.interactions.items.slice(0, 3).map((i) => `- ${longDate(i.at)}, ${md(i.channel.toLowerCase())}: ${md(sentence(i.summary))}${i.by ? ` (${md(i.by)})` : ''}`));
  const seen = p.household.filter((h) => h.inPurview && h.name);
  const unseen = p.household.length - seen.length;
  section('Household', [...seen.map((h) => `- ${md(h.name!)}${h.branch ? `, ${md(h.branch)}` : ''}`), ...(unseen > 0 ? [`- ${unseen} more outside your access`] : [])]);
  section('Suggested agenda', [
    ...points.slice(0, 4).map((t, i) => `${i + 1}. ${md(sentence(t))}`),
    `${Math.min(points.length, 4) + 1}. Agree the next step and confirm ${p.contact.preferred.toLowerCase()} is still the best way to reach ${md(p.firstName)}.`,
  ]);

  return {
    id: newBlockId('brf'),
    type: 'text',
    version: '1.0.0',
    title: `Meeting brief: ${p.name}`,
    provenance: { ...provenance(runId, ['relationship.profile.get', 'relationship.next_best_conversation']), sources: [{ kind: 'table', label: 'Relationship Manager', ref: 'table:cdm_party' }, { kind: 'model', label: `Attrition score, ${longDate(p.attrition.runDate)}` }] },
    freshness: freshness(p),
    output: { label: 'Meeting brief', summary: `${p.name}, ${p.branch}` },
    data: { markdown: lines.join('\n').trim().slice(0, 8000) },
  };
}

/** "Why?" on a score: the main factors and the model's run date (FE-RM-002). */
export function scoreFactors(explained: { score: string; value: string; factors: { label: string; effect: string }[]; model: string; runDate: string }, p: MemberProfile, runId: string): ListBlock {
  return {
    id: newBlockId('why'),
    type: 'list',
    version: '1.0.0',
    title: `${explained.score}: ${explained.value}`,
    subtitle: `Scored ${longDate(explained.runDate)}`,
    provenance: { ...provenance(runId, ['predictive.scores.explain']), sources: [{ kind: 'model', label: explained.score === 'Attrition risk' ? 'Attrition score' : 'Next-best-product score' }] },
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
