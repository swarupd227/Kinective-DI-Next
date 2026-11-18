// People and roles from the ontology (Core Mapping and Ontology, phase 7): everyone with a say over an
// account, in the roles DI's ontology defines, and whether applicants are people the institution
// already knows, scored on the identity properties the ontology weights. Read only; code writes every
// figure and sentence.
import { z } from 'zod';
import { CoreError, POSSIBLE_MATCH, SAME_PERSON, type PeopleService } from '@dinext/di-core';
import { ontology } from '@dinext/ontology';
import { moduleTable, type ModuleContext, type ModuleSpec } from './moduleAgent.ts';

export const PEOPLE_AGENT = 'Identity and Roles';
const n = (x: number) => x.toLocaleString('en-US');
const plural = (x: number, one: string, many = `${one}s`) => `${n(x)} ${x === 1 ? one : many}`;
const text = (field: string, headerName: string) => ({ field, headerName, type: 'text' as const });

/** "Who is on account 12345?", "Everyone with a say over account …4821", "Which applicants are already members?" */
export const PEOPLE_REQUEST =
  /\bwho(?:['’]s| is| are)? on (?:the |this )?(?:account|loan|share|certificate)\b|\b(?:everyone|everybody|who) (?:has|with) a say over\b|\broles? on (?:the |this |an )?account\b|\b(?:already|existing) (?:a )?(?:members?|customers?)\b[^?]*\bapplicants?\b|\bapplicants?\b[^?]*\b(?:already|existing) (?:a )?(?:members?|customers?)\b|\bmatch (?:the )?(?:membership |new |account )?applicants\b|\bsame person\b|\bduplicate (?:members|customers|people)\b|\b(?:test|trial|try) (?:the )?(?:person |people )?matching\b|\bmatching (?:trial|test)\b|\bhow (?:well|good) (?:does|is) (?:person |people )?matching\b/i;

/** The identity weights, in words, from the ontology: "birth date 30%, last name 25%". */
function weightsLine() {
  const o = ontology();
  return [...o.properties.values()]
    .filter((p) => p.match)
    .sort((a, b) => b.match!.weight - a.match!.weight)
    .map((p) => `${p.label.toLowerCase()} ${Math.round(p.match!.weight * 100)}%`)
    .join(', ');
}

export function peopleModule(svc: PeopleService, person: 'member' | 'customer'): ModuleSpec {
  const noAccess = 'People and account roles are part of Membership access.';
  const need = (ctx: ModuleContext) => {
    if (!ctx.modules.includes('membership')) throw new CoreError('NO_ACCESS', noAccess);
  };
  const persons = `${person}s`;
  const spec: ModuleSpec = {
    id: 'membership',
    prefix: 'ppl',
    agent: PEOPLE_AGENT,
    request: PEOPLE_REQUEST,
    noAccess,
    sources: [
      { kind: 'table', label: 'Account owners and roles', ref: 'table:cdm_account_owner' },
      { kind: 'table', label: 'DI ontology', ref: 'table:onto_concept' },
    ],
    prompt: ({ tenant, user, title }) => `You are the ${PEOPLE_AGENT} agent inside Kinective Data Intelligence (DI) for ${tenant}. ${user} (${title}) asks about the people on accounts and whether people are already ${persons}.

- "Who is on account 12345?", "Everyone with a say over account …4821": ppl_on_account with the number as given.
- "Which membership applicants are already ${persons}?", "Match the applicants": ppl_match_applicants.
- "How well does person matching handle typos?", "Test person matching": ppl_match_trial.
- Roles and what each allows come from DI's ontology; matches are scored on the identity properties it weights. Never guess a role or a match.`,
    plan: (t) => {
      const acct = /\b(?:account|loan|share|certificate)\b[^0-9]*?(?:…|\.\.\.|ending (?:in )?)?\s*(\d{1,12})\b/i.exec(t) ?? /(?:…|\.\.\.)\s*(\d{4})\b/.exec(t) ?? /\b(\d{4,12})\b/.exec(t);
      if (/\b(?:test|trial|try)\b[^?]*\bmatching\b|\bmatching (?:trial|test)\b|\bhow (?:well|good)\b[^?]*\bmatching\b/i.test(t)) return { tool: 'ppl_match_trial', args: {} };
      if (/\bapplicants?\b|\bsame person\b|\bduplicate\b/i.test(t)) return { tool: 'ppl_match_applicants', args: {} };
      const kind = /\bloans?\b/i.test(t) ? 'loan' : /\b(?:share|deposit|savings|checking|certificate|CD|IRA|money market)\b/i.test(t) ? 'deposit' : undefined;
      return acct ? { tool: 'ppl_on_account', args: { account: acct[1]!, ...(kind ? { kind } : {}) } } : { say: 'Which account? Give its number, or its last four digits.' };
    },
    tools: [
      {
        name: 'ppl_on_account',
        description: 'Everyone with a role on one share, deposit or loan account, in the roles DI’s ontology defines (owner, joint owner, beneficiary, signer, co-borrower…), what each role allows, the membership’s representative payee flag and the household.',
        input: z.object({ account: z.string().min(1).max(20), kind: z.enum(['deposit', 'loan']).optional() }).strict(),
        run: async (a: { account: string; kind?: 'deposit' | 'loan' }, ctx: ModuleContext) => {
          need(ctx);
          const r = await svc.onAccount(a.account, ctx.purviewBranches, a.kind);
          const shown = r.parties.filter((p) => p.visible);
          const hidden = r.parties.length - shown.length;
          const who = shown.map((p) => `**${p.name}**, ${p.role.toLowerCase()}${p.means && p.roleId !== 'primary' ? ` (${p.means.charAt(0).toLowerCase()}${p.means.slice(1).replace(/\.$/, '')})` : ''}`).join('; ');
          const what = r.kind === 'loan' ? `${r.product} loan` : `${r.product} account`;
          const parts = [
            `The **${what} ending ${String(r.accountId).slice(-4)}** has ${plural(r.parties.length, 'person', 'people')} on it: ${who || 'none you can see'}.`,
            hidden ? `${plural(hidden, 'more person', 'more people')} ${hidden === 1 ? 'is' : 'are'} on it outside your branches.` : '',
            r.repPayee ? 'The membership has a **representative payee**: benefit payments are received and managed for the owner, though DI holds no record of who the payee is.' : '',
            r.household ? `The primary owner is in ${r.household.name ?? 'a household'}${r.household.head ? `, headed by ${r.household.head}` : ''}, ${plural(r.household.members, 'person', 'people')} in all.` : '',
          ];
          return {
            text: parts.filter(Boolean).join(' '),
            blocks: [moduleTable(spec, `On the ${what} ending ${String(r.accountId).slice(-4)}`, ctx.runId, 'people.account_roles', [text('name', 'Person'), text('role', 'Role'), text('means', 'What the role allows')], shown.map((p) => ({ name: p.name, role: p.role, means: p.means })))],
            suggestions: shown[0] ? [`Tell me about ${shown[0].name}`] : [],
          };
        },
      },
      {
        name: 'ppl_match_applicants',
        description: `Match every membership applicant against the people DI holds, scored on the identity properties DI’s ontology weights, and compare DI’s decisions with the person each application is recorded against.`,
        input: z.object({}).strict(),
        run: async (_a: Record<string, never>, ctx: ModuleContext) => {
          need(ctx);
          const r = await svc.matchApplicants();
          const review = r.rows.filter((x) => x.result.decision === 'possible match');
          const wrongSame = r.rows.filter((x) => x.result.decision === 'same person' && x.result.partyId !== x.recorded).length;
          const parts = [
            `Of **${n(r.all.applicants)} membership applicants**, DI matched **${n(r.all.same)}** to a ${person} it already holds as the same person, ${wrongSame ? `**${n(wrongSame)} of them to a different ${person} than the application records**` : `each the ${person} the application is recorded against`}: ${n(r.existing.same)} who were ${persons} before they applied and ${n(r.booked.same)} whose membership the application opened.`,
            r.all.missed ? `It found no match for ${plural(r.all.missed, 'applicant')} the application links to a ${person}.` : `It missed none the applications link to a ${person}.`,
            review.length ? `**${plural(review.length, 'more applicant')}** ${review.length === 1 ? 'is a possible match' : 'are possible matches'} for a person to check: ${review.slice(0, 3).map((x) => `${x.name} and ${x.result.name} (${x.result.agreed.join(', ')})`).join('; ')}.` : 'No applicant is left for a person to check.',
            `A score is the weighted share of the applicant’s details that agree, with the ontology’s weights (${weightsLine()}); ${Math.round(SAME_PERSON * 100)}% or more with no close second is the same person, ${Math.round(POSSIBLE_MATCH * 100)}% or more a possible match.`,
          ];
          return {
            text: parts.join(' '),
            blocks: review.length
              ? [moduleTable(spec, 'Possible matches to check', ctx.runId, 'people.match', [text('applicant', 'Applicant'), text('known', `Closest ${person}`), text('score', 'Score'), text('agreed', 'Agrees on')], review.map((x) => ({ applicant: x.name, known: x.result.name ?? '', score: `${Math.round(x.result.score * 100)}%`, agreed: x.result.agreed.join(', ') })))]
              : [],
          };
        },
      },
      {
        name: 'ppl_match_trial',
        description: `A trial of person matching on altered copies of real ${persons} (a misspelled name, a familiar first name, a street written out, a move, a birth date with day and month swapped) and on made-up people: how often matching exactly and matching that allows for slips each decide right, leave it to a person, or go wrong. Nothing is stored.`,
        input: z.object({}).strict(),
        run: async (_a: Record<string, never>, ctx: ModuleContext) => {
          need(ctx);
          const r = await svc.matchTrial(100);
          const tried = r.kinds.reduce((x, k) => x + k.fuzzy.tried, 0);
          const sum = (key: 'same' | 'possible' | 'wrong', mode: 'exact' | 'fuzzy') => r.kinds.reduce((x, k) => x + k[mode][key], 0);
          const wrong = sum('wrong', 'fuzzy') + r.strangers.fuzzy.wrong;
          const gained = r.kinds.filter((k) => k.fuzzy.same > k.exact.same).map((k) => `${k.kind.toLowerCase()} (${n(k.exact.same)} to ${n(k.fuzzy.same)} of ${n(k.fuzzy.tried)})`);
          const parts = [
            `I altered **${n(tried)} real ${persons}’ records** the way people slip on forms, and made up **${n(r.strangers.fuzzy.tried)} people** who aren’t ${persons}. Allowing for slips, DI decided **${n(sum('same', 'fuzzy'))}** of the altered records were the right ${person} on its own, left **${n(sum('possible', 'fuzzy'))}** for a person to check, and matched **${wrong ? n(wrong) : 'none'}** to the wrong ${person}${r.strangers.fuzzy.wrong ? ' or a made-up person to a real one' : ''}.`,
            `Matching exactly, as before, decided ${n(sum('same', 'exact'))} on its own and left ${n(sum('possible', 'exact'))} to check.`,
            gained.length ? `Allowing for slips helps most with ${gained.join(' and ')}.` : '',
            'Two slips at once, such as a misspelled last name after a move, still go to a person.',
          ];
          const pct = (t: { tried: number; same: number }) => (t.tried ? `${Math.round((t.same / t.tried) * 100)}%` : '—');
          const strangers = (t: { tried: number; wrong: number }) => `${n(t.tried - t.wrong)} of ${n(t.tried)} left new`;
          return {
            text: parts.filter(Boolean).join(' '),
            blocks: [
              moduleTable(spec, 'Person matching on altered records', ctx.runId, 'people.match_trial', [text('kind', 'Change to the record'), text('exact', 'Decided, matching exactly'), text('fuzzy', 'Decided, allowing for slips'), text('check', 'Left to check'), text('wrong', 'Wrong')], [
                ...r.kinds.map((k) => ({ kind: k.kind, exact: pct(k.exact), fuzzy: pct(k.fuzzy), check: n(k.fuzzy.possible), wrong: n(k.fuzzy.wrong) })),
                { kind: r.strangers.kind, exact: strangers(r.strangers.exact), fuzzy: strangers(r.strangers.fuzzy), check: n(r.strangers.fuzzy.possible), wrong: n(r.strangers.fuzzy.wrong) },
              ]),
            ],
          };
        },
      },
    ],
  };
  return spec;
}
