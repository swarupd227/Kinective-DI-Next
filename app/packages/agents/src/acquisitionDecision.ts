// "Could we afford to acquire a bank that size?" on the decision framework. DI holds no data on a target,
// so the planner says so and sizes a typical community bank from the question. Capital, liquidity,
// concentration and stress specialists report their limits; the planner prices the deal three ways (all
// cash, half and half, all stock), AcquisitionModel computes the combined bank, the chief risk officer
// challenges each, and revisions move to more stock, a lower price and then a smaller bank until the limits
// hold, so the answer is the largest deal the bank can afford. The memo goes to the board behind a card.
import { z } from 'zod';
import type { Block } from '@dinext/block-schemas';
import { AcquisitionService, CoreError, EARNBACK_MAX_YEARS, type AcquisitionModel, type DealCheck, type DealFigures, type DealLevers, type FileStore } from '@dinext/di-core';
import type { Pool } from '@dinext/tenant-db';
import { newBlockId } from './answer.ts';
import { amountFrom } from './capitalPlan.ts';
import { capitalSpecialists, mm, p1, p2, signed, usd, SOURCES } from './capitalDecision.ts';
import { runDecision, type Challenge, type DecisionCase, type DecisionOption, type Evaluated } from './decision.ts';
import type { ModuleContext, ModuleSpec } from './moduleAgent.ts';

export const ACQUISITION_REQUEST = /\b(?:could|can|should) we (?:afford to )?(?:acquire|buy|purchase)\b[^.?!]{0,40}\b(?:bank|institution|credit union)\b|\bafford (?:to )?(?:acquire|buy)\b|\b(?:acquisition|merger) (?:capacity|affordability)\b|\bhow (?:big|large) (?:a|of a) (?:bank|deal|acquisition) could we\b/i;
export const ACQUISITION_AGENT = 'Acquisition';
const MODULE = 'capactions';
const NO_ACCESS = 'Acquisition analysis isn’t part of your DI access. It is for a bank’s finance leaders.';
const BOARD_FOLDER = 'Board Packs';
const DEFAULT_TARGET = 500e6;
const MIN_TARGET = 50e6;

type Option = DecisionOption<DealLevers>;
type Result = Evaluated<DealLevers, DealFigures>;
const NOUN: Record<string, string> = { leverage: 'the leverage floor', cet1: 'the CET1 floor', liquidity: 'liquidity', office: 'office concentration', cre: 'CRE concentration', earnback: 'the earn-back' };
const x1 = (n: number) => `${n.toFixed(1)}×`;
/** A price sellers will take: the lowest multiple of tangible book a revision offers. */
const MIN_PRICE = 1.1;

/** The target's size from the question: "$500M", "a $1.2 billion bank", "our size", "half our size". */
export function targetSizeFrom(text: string, ownAssets: number): { assets: number; said: boolean } {
  if (/\bhalf (?:our|of our) size\b/i.test(text)) return { assets: Math.round(ownAssets / 2 / 25e6) * 25e6, said: true };
  if (/\b(?:our|the same) size\b|\bas big as (?:us|ours)\b/i.test(text)) return { assets: Math.round(ownAssets / 25e6) * 25e6, said: true };
  const b = /\$?\s*(\d+(?:\.\d+)?)\s*(?:b\b|bn\b|billion\b)/i.exec(text);
  if (b) return { assets: Number(b[1]) * 1e9, said: true };
  const a = amountFrom(text);
  return a && a >= 10e6 ? { assets: a, said: true } : { assets: DEFAULT_TARGET, said: false };
}

function describe(c: DealCheck, f: DealFigures): string {
  const over = c.status === 'breach';
  switch (c.id) {
    case 'leverage':
      return over ? `Leverage at closing is ${p2(c.value)}, below its ${p2(c.limit)} floor: ${mm(f.intangibles)} of goodwill and intangibles come straight off tier 1.` : `Leverage at closing is ${p2(c.value)} against a ${p2(c.limit)} floor, with nothing left for integration surprises.`;
    case 'cet1':
      return over ? `CET1 at closing is ${p2(c.value)}, below its ${p2(c.limit)} floor.` : `CET1 at closing is ${p2(c.value)}, close to its ${p2(c.limit)} floor.`;
    case 'liquidity':
      return over ? `Paying ${mm(f.cash)} in cash takes liquid assets to ${p2(c.value)} of assets, below the ${c.limit}% minimum.` : `Liquid assets end at ${p2(c.value)} of assets against the ${c.limit}% minimum after ${mm(f.cash)} of cash goes out.`;
    case 'office':
      return over ? `Office CRE reaches ${p1(c.value)} of the combined capital, over the 50% limit: the target brings office loans and the goodwill shrinks the capital they’re measured against.` : `Office CRE reaches ${p1(c.value)} of the combined capital against the 50% limit.`;
    case 'cre':
      return `Non-owner-occupied CRE reaches ${Math.round(c.value)}% of the combined capital against the 300% guidance.`;
    case 'earnback':
      return f.earnbackYears === null ? `The deal dilutes tangible book value ${p1(f.dilutionPct)} and never earns it back.` : `Tangible book value falls ${p1(f.dilutionPct)} and takes ${f.earnbackYears.toFixed(1)} years to earn back; shareholders expect ${EARNBACK_MAX_YEARS}.`;
  }
}

export function acquisitionCase(pool: Pool): DecisionCase<DealLevers, DealFigures> & { model: () => AcquisitionModel } {
  let m: AcquisitionModel | null = null;
  let said = false;
  const model = () => {
    if (!m) throw new Error('The acquisition model is not loaded');
    return m;
  };
  const all = capitalSpecialists(pool);
  const specialists = ['capital', 'liquidity', 'concentration', 'stress'].map((id) => all.find((s) => s.id === id)!);
  const critique = (o: Option, f: DealFigures): Challenge[] =>
    f.checks.filter((c) => c.status === 'breach' || c.status === 'thin').map((c) => ({ option: o.key, check: c.id, severity: c.status === 'breach' ? ('breach' as const) : ('thin' as const), text: describe(c, f) }));
  const ok = (l: DealLevers, ids: string[]) => model().evaluate(l).checks.every((c) => !ids.includes(c.id) || (c.status !== 'breach' && c.status !== 'thin'));

  const options = async (_f: unknown, input: { text: string }): Promise<Option[]> => {
    m = await new AcquisitionService(pool).model();
    if (!m) throw new Error('No figures for an acquisition');
    const size = targetSizeFrom(input.text, m.today.totalAssets);
    said = size.said;
    const at = (cashPct: number) => m!.levers({ targetAssets: size.assets, priceToTbv: 1.3, cashPct });
    return [
      { key: 'cash', name: 'All cash', stance: 'Pay cash: no new shares, but the cash leaves the balance sheet.', levers: at(100) },
      { key: 'mixed', name: 'Half cash, half stock', stance: 'Split the price between cash and our stock.', levers: at(50) },
      { key: 'stock', name: 'All stock', stance: 'Pay in our stock: capital comes in with the deal, and ownership is shared.', levers: at(0) },
    ];
  };

  const revise = (o: Option, _ch: Challenge): { levers: DealLevers; text: string } | null => {
    const mdl = model();
    const l = o.levers;
    // Each structure keeps how it pays; it offers less, then looks for a smaller bank, until the limits hold.
    const hard = ['leverage', 'cet1', 'liquidity', 'office', 'cre'];
    const holds = (x: DealLevers) => mdl.evaluate(x).checks.every((c) => !hard.includes(c.id) || c.status !== 'breach') && ok(x, ['leverage', 'cet1', 'liquidity']);
    for (let p = Math.round((l.priceToTbv - 0.1) * 10) / 10; p >= MIN_PRICE - 1e-9; p = Math.round((p - 0.1) * 10) / 10) {
      if (holds({ ...l, priceToTbv: p })) return { levers: { ...l, priceToTbv: p }, text: `Offer ${x1(p)} tangible book instead of ${x1(l.priceToTbv)}; ${describeShort(mdl.evaluate({ ...l, priceToTbv: p }))}.` };
    }
    const offer = { ...l, priceToTbv: Math.min(l.priceToTbv, MIN_PRICE) };
    for (let a = l.targetAssets - 25e6; a >= MIN_TARGET; a -= 25e6) {
      const x = { ...offer, targetAssets: a };
      if (holds(x)) return { levers: x, text: `Look for a smaller bank: about ${mm(a)} in assets${offer.priceToTbv !== l.priceToTbv ? ` at ${x1(offer.priceToTbv)} tangible book` : ''}; ${describeShort(mdl.evaluate(x))}.` };
    }
    return null;
  };
  const describeShort = (f: DealFigures) => `leverage at closing ${p2(f.levPct)}, liquid assets ${p2(f.liquidPct)} of assets, office CRE ${p1(f.officePct)} of capital`;

  const recommend = (results: Result[]) => {
    const issues = (r: Result) => critique(r.option, r.figures);
    const clear = results.filter((r) => !issues(r).some((x) => x.severity === 'breach'));
    const t = model().today;
    if (!clear.length) return { key: [...results].sort((a, b) => issues(a).length - issues(b).length)[0]!.option.key, why: `No structure considered holds every limit, even for a ${mm(MIN_TARGET)} bank: with leverage at ${p2(t.levPct)} against a ${p2(t.levFloor)} floor, goodwill takes the bank below its floor.` };
    // The largest bank that holds every limit, then the fewest thin spots, then the best earnings.
    const pick = [...clear].sort((a, b) => b.figures.levers.targetAssets - a.figures.levers.targetAssets || issues(a).length - issues(b).length || b.figures.epsRun - a.figures.epsRun)[0]!;
    const others = clear.filter((r) => r !== pick);
    const f = pick.figures;
    const l = f.levers;
    const parts = [
      `The bank can afford about ${mm(l.targetAssets)} in assets at ${x1(l.priceToTbv)} tangible book (${mm(f.price)}), ${l.cashPct ? `${l.cashPct}% in cash` : 'all in stock'}${l.cashPct && l.cashPct < 100 ? ` and ${100 - l.cashPct}% in stock` : ''}.`,
      `Leverage at closing is ${p2(f.levPct)} against its ${p2(t.levFloor)} floor, liquid assets ${p2(f.liquidPct)} of assets, office CRE ${p1(f.officePct)} of capital.`,
      `Run-rate EPS goes to ${usd(f.epsRun)} (${signed(f.epsChangePct)}); tangible book value a share falls ${p1(f.dilutionPct)}${f.earnbackYears !== null ? `, earned back in ${f.earnbackYears.toFixed(1)} years` : ''}${f.newShares ? `, and the target’s holders would own ${p1(f.ownershipPct)} of the combined bank` : ''}.`,
      others.length ? `Paid ${others.map((r) => `${r.option.name.toLowerCase()}, it is about ${mm(r.figures.levers.targetAssets)}`).join('; ')}.` : '',
      t.levPct - t.levFloor < 1 ? `What limits it is capital: leverage is ${p2(t.levPct)} today against a ${p2(t.levFloor)} floor, and goodwill comes straight off tier 1.` : '',
    ];
    return { key: pick.option.key, why: parts.filter(Boolean).join(' ') };
  };

  const rowsFor = (results: Result[]) => {
    const t = model().today;
    const row = (item: string, get: (f: DealFigures) => string, now = '') => ({ item, now, ...Object.fromEntries(results.map((r) => [r.option.key, get(r.figures)])) });
    return [
      row('Target’s assets', (f) => mm(f.levers.targetAssets), `${mm(t.totalAssets)} (this bank)`),
      row('Price (to tangible book)', (f) => `${mm(f.price)} (${x1(f.levers.priceToTbv)})`),
      row('Paid in cash / stock', (f) => `${mm(f.cash)} / ${mm(f.stock)}`),
      row('Goodwill and intangibles', (f) => mm(f.intangibles)),
      row('Leverage ratio at closing (floor)', (f) => `${p2(f.levPct)} (${p2(t.levFloor)})`, `${p2(t.levPct)} (${p2(t.levFloor)})`),
      row('CET1 at closing', (f) => p2(f.cet1Pct), p2(t.cet1Pct)),
      row(`Liquid assets to assets (minimum ${t.liquidMin}%)`, (f) => p2(f.liquidPct)),
      row('Office CRE to capital (limit 50%)', (f) => p1(f.officePct), p1(t.officePct)),
      row('EPS run rate', (f) => `${usd(f.epsRun)} (${signed(f.epsChangePct)})`, usd(t.eps)),
      row('Tangible book value a share', (f) => `${usd(f.tbvps)} (−${p1(f.dilutionPct)})`, usd(t.tbvps)),
      row(`Earn-back (aim ${EARNBACK_MAX_YEARS} years)`, (f) => (f.earnbackYears === null ? 'Never' : `${f.earnbackYears.toFixed(1)} years`)),
      row('Target’s holders own', (f) => (f.newShares ? p1(f.ownershipPct) : 'None')),
      row('Limits', (f) => {
        const b = f.breaches.length;
        return b ? `${b} breach${b === 1 ? '' : 'es'}` : f.thin.length ? `${f.thin.length} thin` : 'Clear';
      }),
    ];
  };

  return {
    agent: ACQUISITION_AGENT,
    title: 'Could we afford an acquisition?',
    get planText() {
      return 'DI holds no data on a target bank, so I’ll model a typical community bank of the size you asked about, with every assumption stated; give me the target’s own figures and I’ll rerun it. The capital, liquidity, concentration and stress specialists report their limits at the same time; I price the deal three ways (all cash, half and half, all stock) and DI computes the combined bank; the chief risk officer challenges each; if a deal doesn’t fit, I find the largest one that does, then draft the board memo for your approval.';
    },
    specialists,
    options,
    evaluate: (l) => model().evaluate(l),
    critique,
    stands: (_o, ch) =>
      ch.check === 'earnback'
        ? 'The earn-back is the market’s test, not a limit; the board weighs it against the earnings the deal buys.'
        : ch.check === 'office' || ch.check === 'cre'
          ? 'The target is assumed to lend like we do; its own loan tape decides this, and a deal can leave its office loans out.'
          : null,
    revise,
    stuck: (o) =>
      o.levers.cashPct > 0
        ? `Even a ${mm(MIN_TARGET)} bank at ${x1(MIN_PRICE)} tangible book, paid ${o.levers.cashPct}% in cash, breaks a limit. Cash buys the target’s assets without its capital, and leverage has no room for that; this structure is off the table.`
        : `Even a ${mm(MIN_TARGET)} bank at ${x1(MIN_PRICE)} tangible book breaks a limit; this structure is off the table.`,
    nouns: NOUN,
    order: ['leverage', 'cet1', 'liquidity', 'office', 'cre', 'earnback'],
    recommend,
    blocks: (results, runId) => {
      const t = (field: string, headerName: string) => ({ field, headerName, type: 'text' as const });
      const rows = rowsFor(results);
      return [{ id: newBlockId('acq'), type: 'table', version: '1.0.0', title: 'Three ways to pay for the acquisition', subtitle: `${said ? 'The size you asked about' : `No size given, so a ${mm(DEFAULT_TARGET)} bank`}, as revised; a typical community bank’s profile, at closing and a year on.`, provenance: { agent: ACQUISITION_AGENT, runId, operations: ['acq.plans'], sources: SOURCES }, freshness: { kind: 'workflow_event' }, data: { columns: [t('item', ''), t('now', 'Today'), ...results.map((r) => t(r.option.key, r.option.name))], rows, rowCount: rows.length } } as Block];
    },
    memo: (chosen, why, results, replies) => ({
      tool: 'acq_memo',
      args: { recommended: chosen.option.key, plans: results.map((r) => ({ key: r.option.key, name: r.option.name, levers: r.option.levers })), why, settled: replies.map((r) => `${results.find((x) => x.option.key === r.option)?.option.name ?? r.option}, round ${r.round}: ${r.action === 'revise' ? 'revised' : 'stands'}. ${r.text}`).slice(0, 12) },
    }),
    corpus: (results) => {
      const out = rowsFor(results).flatMap((r) => Object.values(r));
      for (const r of results) out.push(...critique(r.option, r.figures).map((c) => c.text), describeShort(r.figures), mm(r.figures.price), mm(r.figures.cash), mm(r.figures.intangibles), String(r.figures.levers.cashPct), String(100 - r.figures.levers.cashPct));
      out.push(mm(DEFAULT_TARGET), String(EARNBACK_MAX_YEARS));
      return out;
    },
    facts: (results) =>
      rowsFor(results)
        .map((r) => `${r.item}: today ${r.now || 'n/a'}; ${results.map((x) => `${x.option.name} ${(r as Record<string, string>)[x.option.key]}`).join('; ')}`)
        .join('\n'),
    summary: (f) => `${f.binding}: ${f.current} against ${f.limit}; ${f.headroom}`,
    suggestions: ['Plan our capital actions for next year', 'What are our Basel III ratios?'],
    model,
  };
}

const MemoInput = z.object({
  recommended: z.string().max(40),
  plans: z.array(z.object({ key: z.string().max(40), name: z.string().max(60), levers: z.object({ targetAssets: z.number().min(1e6).max(1e11), priceToTbv: z.number().min(0.5).max(4), cashPct: z.number().min(0).max(100) }) })).min(1).max(4),
  why: z.string().max(1500),
  settled: z.array(z.string().max(500)).max(12),
});

export function acquisitionMemo(m: AcquisitionModel, input: z.infer<typeof MemoInput>, from: { name: string; title: string }) {
  const t = m.today;
  const plans = input.plans.map((x) => ({ ...x, f: m.evaluate(x.levers) }));
  const rec = plans.find((x) => x.key === input.recommended) ?? plans[0]!;
  const f = rec.f;
  const line = (label: string, get: (x: DealFigures) => string) => `- ${label}: ${plans.map((x) => `${x.name} ${get(x.f)}`).join('; ')}`;
  const body = [
    'To: Board of Directors',
    `From: ${from.name}, ${from.title}`,
    'Re: What acquisition the bank could afford',
    '',
    'DI holds no data on a specific target; these figures are for a typical community bank of the size shown. A real target’s own figures replace them.',
    '',
    f.breaches.length ? `Finding: no structure considered holds every limit. ${input.why}` : `Finding: a bank of about ${mm(f.levers.targetAssets)} in assets, at ${x1(f.levers.priceToTbv)} tangible book (${mm(f.price)}), ${f.levers.cashPct}% in cash and ${100 - f.levers.cashPct}% in stock.`,
    '',
    `Why: ${input.why}`,
    '',
    'By structure, as revised:',
    line('Target’s assets', (x) => mm(x.levers.targetAssets)),
    line('Price', (x) => `${mm(x.price)} (${x1(x.levers.priceToTbv)})`),
    line(`Leverage at closing (floor ${p2(t.levFloor)})`, (x) => p2(x.levPct)),
    line('Liquid assets to assets', (x) => p2(x.liquidPct)),
    line('Office CRE to capital', (x) => p1(x.officePct)),
    line('Run-rate EPS', (x) => `${usd(x.epsRun)} (${signed(x.epsChangePct)})`),
    line('Tangible book value dilution', (x) => p1(x.dilutionPct)),
    line('Earn-back', (x) => (x.earnbackYears === null ? 'never' : `${x.earnbackYears.toFixed(1)} years`)),
    '',
    'The chief risk officer’s challenges, and how they were settled:',
    ...(input.settled.length ? input.settled.map((s) => `- ${s}`) : ['- None.']),
    '',
    'Asked of the board: whether to look for a target of this size. Nothing is offered to anyone.',
    `Figures are DI’s estimates from the ${t.quarter} Call Report; the target is assumed.`,
  ].join('\n');
  return { rec, memo: { to: ['Board of Directors'], subject: 'What acquisition the bank could afford', body: body.slice(0, 4000) } };
}

export function acquisitionModule(deps: { pool: Pool; files?: FileStore | null; today?: () => string }): ModuleSpec {
  const need = (ctx: ModuleContext) => {
    if (!ctx.modules.includes(MODULE)) throw new CoreError('NO_ACCESS', NO_ACCESS);
  };
  const spec: ModuleSpec = {
    id: MODULE,
    prefix: 'acq',
    agent: ACQUISITION_AGENT,
    request: ACQUISITION_REQUEST,
    noAccess: NO_ACCESS,
    sources: SOURCES,
    prompt: ({ tenant, user, title }) => `You size what acquisition ${tenant} could afford. You are working with ${user}, ${title}.`,
    plan: () => ({ say: 'Ask me whether we could afford to acquire a bank of a given size.' }),
    run: (input, d, sink) => runDecision(spec, acquisitionCase(deps.pool), input, d, sink),
    tools: [
      {
        name: 'acq_memo',
        description: 'Draft the board memo on what acquisition the bank could afford. Sending it needs approval.',
        input: MemoInput,
        run: async (args: z.infer<typeof MemoInput>, ctx) => {
          need(ctx);
          const m = await new AcquisitionService(deps.pool).model();
          if (!m) throw new CoreError('NOT_FOUND', 'There are no capital figures yet.');
          const { rec, memo } = acquisitionMemo(m, args, { name: ctx.user.name, title: 'Chief Financial Officer' });
          return {
            change: {
              summary: 'Send the board the memo on what acquisition we could afford',
              changes: [
                { label: 'Target size', before: '—', after: mm(rec.f.levers.targetAssets) },
                { label: 'Price and payment', before: '—', after: `${mm(rec.f.price)}, ${rec.f.levers.cashPct}% cash` },
                { label: 'Goes to', before: '—', after: `Board of Directors, in ${BOARD_FOLDER}` },
              ],
              text: 'I’ve drafted the board memo.',
              done: `Sent. The memo is in ${BOARD_FOLDER}. Nothing has been offered to anyone.`,
              risk: 'high',
              apply: { memo, plan: rec.key },
            },
          };
        },
        apply: async (a: { memo: { subject: string; body: string } }, meta, ctx) => {
          need(ctx);
          if (!deps.files) return;
          const on = deps.today?.() ?? new Date().toISOString().slice(0, 10);
          const staged = await deps.files.stage({ name: `${a.memo.subject.slice(0, 80)}.txt`, body: Buffer.from(`${a.memo.subject}\n\n${a.memo.body}\n`, 'utf8'), owner: { userId: ctx.user.id, name: ctx.user.name }, on });
          await deps.files.save({ fileId: staged.fileId, folder: BOARD_FOLDER }, { approvalId: meta.approvalId, on });
        },
      },
    ],
  };
  return spec;
}
