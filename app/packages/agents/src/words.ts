// An institution's own words (Core Mapping and Ontology, phase 11), on the Data Lineage agent. DI
// lists the questions it couldn't read, says what each unread word might mean from the ontology (or
// that it needs a new measure), and adds a word only through an approved change, after which every
// question reads it: "How many owners do we have?" at a bank that approved "owners" for customers.
import { z } from 'zod';
import { CoreError } from '@dinext/di-core';
import { meaningNamed, ontology, proposeMeaning, wordMeans, type InstitutionWord, type MeaningProposal } from '@dinext/ontology';
import type { SemanticService, WordStore } from '@dinext/semantic';
import { readConcepts } from './concepts.ts';
import { moduleTable, type ModuleContext, type ModuleSpec, type ModuleTool } from './moduleAgent.ts';

export interface WordsDeps {
  store: WordStore;
  semantic: SemanticService;
  type: 'credit_union' | 'bank';
}

const Q = `["“”']?`;
/** A word or short phrase of up to four words. */
const TERM = `${Q}([a-z][a-z0-9&'-]*(?: [a-z0-9&'-]+){0,3})${Q}`;
/** A meaning: a few plain words, never a sentence that goes on ("urgent and show loans"). */
const MEANING = `((?:(?!\\b(?:and|then|please|show|list|give)\\b)[a-z0-9 &'-]){2,40}?)`;
/** "Which questions couldn't DI read?", "What words doesn't DI know?" */
export const UNREAD_REQUEST = /\b(?:which|what) questions (?:could(?:n['’]t| not)|did(?:n['’]t| not)|can(?:['’]t|not)) (?:DI )?(?:read|answer|understand|map)\b|\bunread questions\b|\b(?:which|what) words (?:does(?:n['’]t| not)|could(?:n['’]t| not)|can(?:['’]t|not)) DI (?:read|know|understand)\b|\bquestions DI could(?:n['’]t| not) (?:read|answer)\b/i;
/** "Treat “owners” as customers", "“owners” means customers", "Add owners as a word for customers". */
export const ADD_WORD = new RegExp(`^(?:please )?(?:treat|read|take) ${TERM} as (?:an? |the |our )?${MEANING}[.!]?$|^${TERM} (?:means|is (?:our|another|a) word for) (?:an? |the |our )?${MEANING}[.!]?$|^(?:please )?add ${TERM} as (?:a |another )?(?:word|synonym|name) for (?:an? |the |our )?${MEANING}[.!]?$`, 'i');
/** "Stop treating “owners” as customers", "Remove the word owners". */
export const REMOVE_WORD = new RegExp(`^(?:please )?(?:stop (?:treating|reading)|don['’]t (?:treat|read)) ${TERM}(?: as .+?)?[.!]?$|^(?:please )?remove (?:the (?:word|synonym) )?${TERM}(?: as a (?:word|synonym) for .+?)?[.!]?$`, 'i');
/** "Which words have we added?", "Show our own words". */
export const LIST_WORDS = /\b(?:our|the institution['’]s) own words\b|\bwhich words (?:have we|did we|has DI been asked to) add(?:ed)?\b|\bwords we(?:['’]ve| have) added\b/i;

export const WORDS_REQUEST = new RegExp([UNREAD_REQUEST.source, ADD_WORD.source, REMOVE_WORD.source, LIST_WORDS.source].join('|'), 'i');

/** The tool and arguments a words request asks for, or null. */
export function wordsPlan(text: string): { tool: string; args: Record<string, string> } | null {
  const t = text.trim().replace(/\?$/, '');
  if (UNREAD_REQUEST.test(t)) return { tool: 'onto_unread', args: {} };
  if (LIST_WORDS.test(t)) return { tool: 'onto_words', args: {} };
  const r = REMOVE_WORD.exec(t);
  if (r) return { tool: 'onto_word_remove', args: { term: (r[1] ?? r[2])!.trim() } };
  const a = ADD_WORD.exec(t);
  if (a) {
    const [term, meaning] = a[1] ? [a[1], a[2]] : a[3] ? [a[3], a[4]] : [a[5], a[6]];
    return { tool: 'onto_word_add', args: { term: term!.trim(), meaning: meaning!.trim() } };
  }
  return null;
}

const NO_CHANGE = 'Changing the words DI reads for the institution isn’t part of your DI access. An administrator, analyst or executive can.';
const quote = (s: string) => `“${s}”`;
const list = (xs: string[]) => (xs.length <= 2 ? xs.join(' and ') : `${xs.slice(0, -1).join(', ')} and ${xs.at(-1)}`);
const plural = (n: number, one: string, many = `${one}s`) => `${n.toLocaleString('en-US')} ${n === 1 ? one : many}`;

interface Reading {
  question: string;
  times: number;
  last: string;
  /** Read now: a word added since, or a change to the catalog. */
  readNow: boolean;
  unknown: { term: string; proposals: MeaningProposal[] }[];
}

/** Every unread question as DI reads it today, with what each unknown word might mean. */
async function readings(d: WordsDeps, words: InstitutionWord[]): Promise<Reading[]> {
  const o = ontology();
  const out: Reading[] = [];
  for (const u of await d.store.unread()) {
    const { hints } = readConcepts(u.question, d.type, d.semantic.dimensionValues, words);
    const c = d.semantic.search(u.question, hints);
    const readNow = c.matched && !c.unknownTerms.length;
    // Only words a vocabulary could hold: not short words, and not a name (capitalized after the first word), which is a person or place.
    const vocab = c.unknownTerms.filter((term) => term.length >= 3 && !new RegExp(`(?<=\\S\\s+)${term.charAt(0).toUpperCase()}${term.slice(1).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`).test(u.question));
    out.push({ ...u, readNow, unknown: readNow ? [] : vocab.map((term) => ({ term, proposals: proposeMeaning(o, term, d.type, d.semantic.dimensionValues, words) })) });
  }
  return out;
}

export function wordsTools(spec: ModuleSpec, d: WordsDeps, need: (ctx: ModuleContext) => void, sources: ModuleSpec['sources']): ModuleTool[] {
  const canChange = (ctx: ModuleContext) => {
    need(ctx);
    if (!ctx.modules.includes('ontology-words')) throw new CoreError('NO_ACCESS', NO_CHANGE);
  };
  const dims = () => d.semantic.dimensionValues;
  return [
    {
      name: 'onto_unread',
      description: 'The questions DI couldn’t map to a defined measure in the last six months, most asked first, as DI reads them today: the words it couldn’t read and what each might mean in DI’s ontology, or that it needs a new measure.',
      input: z.object({}).strict(),
      run: async (_: never, ctx) => {
        need(ctx);
        const words = await d.semantic.refreshWords(true);
        const rs = await readings(d, words);
        if (!rs.length) return { text: 'Every question in the last six months mapped to a defined measure. Nothing is waiting.', sources };
        const open = rs.filter((r) => !r.readNow);
        // Each unknown word once, with how often it was asked and its best meaning.
        const byWord = new Map<string, { times: number; proposals: MeaningProposal[] }>();
        for (const r of open) for (const u of r.unknown) {
          const k = u.term.toLowerCase();
          const prior = byWord.get(k);
          byWord.set(k, { times: (prior?.times ?? 0) + r.times, proposals: prior?.proposals.length ? prior.proposals : u.proposals });
        }
        const learnable = [...byWord].filter(([, v]) => v.proposals.length);
        const none = [...byWord].filter(([, v]) => !v.proposals.length).map(([w]) => quote(w));
        const asked = rs.reduce((n, r) => n + r.times, 0);
        const lines = [
          `**${plural(rs.length, 'question')}** (asked ${plural(asked, 'time')}) in the last six months didn’t map to a defined measure.`,
          rs.length > open.length ? `${plural(rs.length - open.length, 'of them reads', 'of them read')} now.` : '',
          learnable.length ? `DI could learn ${plural(learnable.length, 'word')}: ${learnable.map(([w, v]) => `${quote(w)} could mean **${v.proposals[0]!.label.toLowerCase()}** (${v.proposals[0]!.why.replace(/\.$/, '')})`).join('; ')}.` : '',
          none.length ? `Nothing in DI’s ontology fits ${list(none)}; ${none.length === 1 ? 'it needs' : 'they need'} a measure or a concept your data team would define.` : '',
          learnable.length ? `Approving a word changes how DI reads everyone’s questions here, so it goes through approval.` : '',
        ].filter(Boolean);
        const top = learnable[0];
        return {
          text: lines.join(' '),
          blocks: [
            moduleTable(spec, 'Questions DI couldn’t read', ctx.runId, 'catalog.ontology.unread', [{ field: 'question', headerName: 'Question', type: 'text' }, { field: 'times', headerName: 'Asked', type: 'count' }, { field: 'last', headerName: 'Last asked', type: 'date' }, { field: 'words', headerName: 'Words DI couldn’t read', type: 'text' }, { field: 'means', headerName: 'Could mean', type: 'text' }],
              rs.map((r) => ({
                question: r.question,
                times: r.times,
                last: r.last,
                words: r.readNow ? 'Reads now' : r.unknown.map((u) => u.term).join(', ') || '—',
                means: r.readNow ? '—' : r.unknown.map((u) => (u.proposals[0] ? `${u.term}: ${u.proposals[0].label.toLowerCase()} (${u.proposals[0].strength})` : `${u.term}: needs a measure`)).join('; ') || '—',
              }))),
          ],
          sources: [...(sources ?? []), { kind: 'table', label: 'AI usage ledger', ref: 'table:ai_run' }],
          suggestions: top ? [`Treat “${top[0]}” as ${top[1].proposals[0]!.label.toLowerCase()}`] : ['How much does the data dictionary cover?'],
        };
      },
    },
    {
      name: 'onto_word_add',
      description: 'Add a word for the institution: from now on DI reads it as one of its concepts (a class such as customers, a code such as certificates, or a property a measure reads). Needs approval; refuses a word DI already reads, or a meaning it can’t find.',
      input: z.object({ term: z.string().min(2).max(60), meaning: z.string().min(2).max(80), question: z.string().max(500).optional() }).strict(),
      run: async (a: { term: string; meaning: string; question?: string }, ctx) => {
        canChange(ctx);
        const o = ontology();
        const words = await d.semantic.refreshWords(true);
        const term = a.term.trim().toLowerCase().replace(/^["“”']|["“”']$/g, '');
        if (!/^[a-z][a-z0-9 &'-]*[a-z0-9]$/.test(term) || term.split(' ').length > 4) throw new CoreError('INVALID', `${quote(a.term)} isn’t a word or short phrase DI can add. Use letters, up to four words.`);
        const target = meaningNamed(o, a.meaning, d.type, dims());
        if (!target) {
          const ideas = proposeMeaning(o, a.meaning, d.type, dims(), words);
          throw new CoreError('NOT_FOUND', `I can’t find ${quote(a.meaning)} in DI’s ontology${ideas[0] ? `; did you mean ${ideas[0].label.toLowerCase()}?` : '. Name a concept DI has, such as customers, certificates or loans.'}`);
        }
        const already = wordMeans(o, term, d.type, dims(), words);
        if (already?.id === target.id) return { text: `DI already reads ${quote(term)} as ${already.label.toLowerCase()}. Nothing to add.`, sources };
        // A word DI's ontology defines is Kinective's to change; one the institution added can be pointed elsewhere.
        const own = words.find((w) => w.term === term);
        if (already && !own) throw new CoreError('INVALID', `${quote(term)} already means ${already.label.toLowerCase()} in DI’s ontology, so I won’t change it here. Ask Kinective to change a word DI defines.`);
        // What it would read: the unread questions it would now map, before and after.
        const before = await readings(d, words);
        const after = await readings(d, [...words.filter((w) => w.term !== term), { term, concept: target.id }]);
        const gained = after.filter((r, i) => r.readNow && !before[i]!.readNow);
        return {
          change: {
            summary: `Read ${quote(term)} as ${target.label.toLowerCase()}`,
            changes: [
              { label: 'Word', before: own ? `${quote(term)}: ${meaningLabel(own.concept)}` : '—', after: quote(term) },
              { label: 'Means', before: own ? meaningLabel(own.concept) : '—', after: `${target.label} (${target.kind === 'value' ? `a code: ${target.value}` : target.kind === 'property' ? 'a property' : 'a concept'})` },
              { label: 'Unread questions it reads', before: '—', after: gained.length ? gained.map((g) => quote(g.question)).slice(0, 3).join(', ') : 'None of the logged ones yet' },
              { label: 'Applies to', before: '—', after: 'Every question asked at this institution, from now on' },
            ],
            text: `From now on DI will read ${quote(term)} as **${target.label.toLowerCase()}** in every question asked here.${gained.length ? ` ${plural(gained.length, 'logged question')} that DI couldn’t read would map now.` : ''} DI’s ontology itself doesn’t change; this word is the institution’s own, and it can be removed the same way.`,
            done: `DI now reads ${quote(term)} as **${target.label.toLowerCase()}**.`,
            risk: 'medium',
            apply: { term, concept: target.id, label: target.label, question: a.question ?? gained[0]?.question ?? null },
          },
        };
      },
      apply: async (p: { term: string; concept: string; label: string; question: string | null }, meta, ctx) => {
        await d.store.add({ term: p.term, concept: p.concept, byUser: meta.userId, byName: ctx.user.name, approvalId: meta.approvalId, question: p.question ?? undefined });
        await d.semantic.refreshWords(true);
        return { text: `DI now reads ${quote(p.term)} as **${p.label.toLowerCase()}**. Ask a question with it to see.`, suggestions: [p.question ?? `How many ${p.term} do we have?`] };
      },
    },
    {
      name: 'onto_word_remove',
      description: 'Remove a word the institution added, so DI no longer reads it. Needs approval. Words DI’s ontology defines can’t be removed here.',
      input: z.object({ term: z.string().min(2).max(60) }).strict(),
      run: async (a: { term: string }, ctx) => {
        canChange(ctx);
        const words = await d.semantic.refreshWords(true);
        const term = a.term.trim().toLowerCase().replace(/^["“”']|["“”']$/g, '');
        const own = words.find((w) => w.term === term);
        if (!own) {
          const means = wordMeans(ontology(), term, d.type, dims());
          throw new CoreError('NOT_FOUND', means ? `${quote(term)} is a word DI’s ontology defines (${means.label.toLowerCase()}), not one the institution added, so it can’t be removed here.` : `${quote(term)} isn’t one of the institution’s words.${words.length ? ` They are ${list(words.map((w) => quote(w.term)))}.` : ''}`);
        }
        return {
          change: {
            summary: `Stop reading ${quote(term)} as ${meaningLabel(own.concept)}`,
            changes: [{ label: 'Word', before: `${quote(term)}: ${meaningLabel(own.concept)}`, after: 'Not read' }],
            text: `DI will stop reading ${quote(term)} as ${meaningLabel(own.concept)}; questions that use it will be logged as unread again.`,
            done: `DI no longer reads ${quote(term)}.`,
            risk: 'medium',
            apply: { term },
          },
        };
      },
      apply: async (p: { term: string }, meta, ctx) => {
        await d.store.remove({ term: p.term, byUser: meta.userId, byName: ctx.user.name, approvalId: meta.approvalId });
        await d.semantic.refreshWords(true);
      },
    },
    {
      name: 'onto_words',
      description: 'The words the institution has added to DI’s ontology, what each means, and who approved it when.',
      input: z.object({}).strict(),
      run: async (_: never, ctx) => {
        need(ctx);
        const current = await d.store.current();
        if (!current.length) return { text: 'The institution hasn’t added any words of its own yet. Ask “Which questions couldn’t DI read?” to see the words DI could learn.', sources, suggestions: ['Which questions couldn’t DI read?'] };
        return {
          text: `The institution reads ${plural(current.length, 'word')} of its own: ${current.map((w) => `${quote(w.term)} as ${meaningLabel(w.concept)}`).join(', ')}.`,
          blocks: [moduleTable(spec, 'The institution’s own words', ctx.runId, 'catalog.ontology.words', [{ field: 'term', headerName: 'Word', type: 'text' }, { field: 'means', headerName: 'Means', type: 'text' }, { field: 'by', headerName: 'Approved by', type: 'text' }, { field: 'at', headerName: 'On', type: 'date' }],
            current.map((w) => ({ term: w.term, means: meaningLabel(w.concept), by: w.byName, at: w.at })))],
          sources,
        };
      },
    },
  ] as ModuleTool[];

  function meaningLabel(id: string) {
    const c = meaningNamed(ontology(), id, d.type, dims());
    return c ? c.label.toLowerCase() : id;
  }
}
