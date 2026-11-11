// The next-best-product model's agent: which product each member is likely to open next, from models DI
// trains on its own history of who opened what. How good each product's model is on months it never saw,
// which products it won't use because it can't tell, who is likeliest to open a product and why, a new
// version on request, and a version put to work only when someone other than the requester approves.
// The seeded "products to suggest" and their take-up stay with Predictive Analytics.
import { z } from 'zod';
import { CoreError, NEXT_PRODUCT_BANDS, NEXT_PRODUCT_MIN_AUC, modelMonthLabel, type NextProductModelService, type ProductModel } from '@dinext/di-core';
import { moduleTable, type ModuleContext, type ModuleSpec } from './moduleAgent.ts';

export const NEXT_PRODUCT_REQUEST =
  /\bnext[- ]best[- ]product model\b|\bnext[- ]product model\b|\bproduct (?:propensity|opening) models?\b|\b(?:propensity|product) models? (?:for|by) product\b|\bwhat (?:will|would) (?:\w+ ){0,3}open next\b|\bopen next\b|\bwho (?:will|might|is going to|are going to) open\b[^.?!]*\bnext\b|\bretrain\b[^.?!]*\bproduct\b|\b(?:promote|activate|approve|put)\b[^.?!]*\bproduct model\b|\bproduct model (?:say|says|thinks|predicts)\b/i;

const pct = (v: number, d = 0) => `${(v * 100).toFixed(d)}%`;
const n = (v: number) => Math.round(v).toLocaleString('en-US');
const text = (field: string, headerName: string) => ({ field, headerName, type: 'text' as const });

/** The product a question names, among those the model knows. */
const SYNONYMS: [RegExp, RegExp][] = [
  [/\bcds?\b|\bcertificates?\b|\btime deposits?\b/i, /certificate/i],
  [/\bmoney market\b/i, /money market/i],
  [/\biras?\b|\bretirement\b/i, /\bira\b/i],
  [/\bchecking\b/i, /checking/i],
  [/\bsavings\b/i, /savings/i],
  [/\bcredit cards?\b|\bcards?\b/i, /credit card/i],
  [/\bauto\b|\bcar\b|\bvehicle\b/i, /auto/i],
  [/\bpersonal\b/i, /personal/i],
  [/\bconsumer\b/i, /consumer/i],
  [/\bheloc\b|\bhome equity\b/i, /heloc/i],
  [/\bmortgage\b/i, /mortgage/i],
  [/\bc&i\b|\bcommercial (?:and|&) industrial\b|\bbusiness loan/i, /commercial & industrial|business/i],
];
export function modelProductIn(text: string, products: string[]) {
  for (const [ask, name] of SYNONYMS) if (ask.test(text)) return products.find((p) => name.test(p)) ?? null;
  return products.find((p) => new RegExp(`\\b${p.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i').test(text)) ?? null;
}

/** One product's model in words. */
const oneLine = (m: ProductModel) => `${m.product}: AUC ${m.metrics.auc.toFixed(2)}, its top 10% held ${pct(m.metrics.captured10)} of those who opened one`;

export function nextProductModule(svc: NextProductModelService): ModuleSpec {
  const noAccess = 'Predictive Analytics isn’t part of your DI access.';
  const need = (ctx: ModuleContext) => {
    if (!ctx.modules.includes('predictive')) throw new CoreError('NO_ACCESS', noAccess);
  };
  const names = (ctx: ModuleContext) => ctx.modules.includes('records-members') || ctx.modules.includes('records-customers');
  const active = async () => {
    const a = await svc.active();
    if (!a) throw new CoreError('NOT_FOUND', 'No next-best-product model is in use yet. DI trains the first one when it starts; ask again in a few minutes.');
    return a;
  };

  const spec: ModuleSpec = {
    id: 'predictive',
    prefix: 'nbp',
    agent: 'Next-Best-Product Model',
    request: NEXT_PRODUCT_REQUEST,
    noAccess,
    sources: [
      { kind: 'table', label: 'Model registry', ref: 'table:ml_model' },
      { kind: 'table', label: 'Model scores', ref: 'table:ml_score' },
      { kind: 'table', label: 'Month-end snapshots', ref: 'table:hist_member_snapshot' },
    ],
    prompt: ({ tenant, user, title }) => `You are the Next-Best-Product Model agent inside Kinective Data Intelligence (DI) for ${tenant}. ${user} (${title}) works with the models DI trains on its own history of who opened what.

- "How good is the next-best-product model?": nbp_status. "Who will open a certificate next?", "who does the product model say will open a HELOC?": nbp_top with product.
- "Retrain the next-best-product model": nbp_retrain. "Put next-best-product model version 2 to work": nbp_promote; someone other than the requester approves it.
- Say what the numbers are: chances from models trained on DI's own history, checked on months they never saw. A product whose model can't tell who will open it isn't used, and you say so.`,
    plan: (t) => {
      const v = /\b(?:v|version )(\d+)\b/i.exec(t)?.[1];
      if (/\bretrain\b|\btrain (?:a )?new\b/i.test(t)) return { tool: 'nbp_retrain', args: {} };
      if (/\b(?:promote|activate|approve|put)\b[^.?!]*\b(?:model|version)\b/i.test(t)) return { tool: 'nbp_promote', args: v ? { version: Number(v) } : {} };
      if (/\bwho\b|\bwhich (?:members|customers)\b|\blikel|\bopen next\b|\blist\b|\bsay\b/i.test(t)) return { tool: 'nbp_top', args: { product_text: t } };
      return { tool: 'nbp_status', args: {} };
    },
    tools: [
      {
        name: 'nbp_status',
        description: 'The next-best-product model in use: each product’s model and how it did on months it never saw (AUC, share of openers in its top 10%), how many members are in the High and Medium bands for each product this month, products it doesn’t use because its model was too weak, and any candidate version waiting.',
        input: z.object({}).strict(),
        run: async (_: unknown, ctx) => {
          need(ctx);
          const a = await active();
          const sum = (await svc.summary(ctx.purviewBranches)) ?? [];
          const cand = await svc.candidate();
          const first = a.models[0]!;
          const best = [...a.models].sort((x, y) => y.metrics.captured10 - x.metrics.captured10);
          const people = ctx.modules.includes('records-customers') ? 'customers' : 'members';
          return {
            text: `Next-best-product model **v${a.version}** is ${a.models.length} gradient-boosted models, one for each product, trained on ${modelMonthLabel(first.trainFrom)} to ${modelMonthLabel(first.trainTo)} and checked on ${modelMonthLabel(first.validFrom)} to ${modelMonthLabel(first.validTo)}, months they never saw. The strongest: ${best.slice(0, 3).map(oneLine).join('; ')}.${a.notUsed.length ? ` It doesn’t suggest ${a.notUsed.map((m) => `${m.product.toLowerCase()} (AUC ${m.metrics.auc.toFixed(2)})`).join(', ')}: those models couldn’t tell who would open one well enough, below DI’s ${NEXT_PRODUCT_MIN_AUC.toFixed(2)} bar.` : ''} This month ${n(sum.reduce((s, x) => s + x.high, 0))} suggestions are High, at least ${NEXT_PRODUCT_BANDS.high} times as likely as the average ${people.slice(0, -1)} to open the product.${cand ? ` Version ${cand.version} is a candidate, waiting for approval.` : ''}`,
            blocks: [
              moduleTable(spec, 'Each product’s model', ctx.runId, 'nbp.models', [text('product', 'Product'), text('auc', 'AUC'), text('top', 'Top 10% caught'), text('base', 'Opened a month (average)'), { field: 'high', headerName: 'High this month', type: 'count' }, { field: 'medium', headerName: 'Medium', type: 'count' }, text('drivers', 'What it reads most')], [
                ...sum.map((m) => ({ product: m.product, auc: m.metrics.auc.toFixed(2), top: pct(m.metrics.captured10), base: pct(m.metrics.baseRate, 2), high: m.high, medium: m.medium, drivers: m.importance.slice(0, 3).map((i) => i.label).join(', ') })),
                ...a.notUsed.map((m) => ({ product: `${m.product} (not used)`, auc: m.metrics.auc.toFixed(2), top: pct(m.metrics.captured10), base: pct(m.metrics.baseRate, 2), high: 0, medium: 0, drivers: 'Too weak to use' })),
              ]),
            ],
            suggestions: [`Who will open ${best[0]!.product.toLowerCase()} next?`, 'Retrain the next-best-product model'],
          };
        },
      },
      {
        name: 'nbp_top',
        description: 'For one product, the members the next-best-product model scores likeliest to open it by the next month-end, in purview, with how much likelier than average and the reasons from their own data. product_text is the question or the product’s name.',
        input: z.object({ product_text: z.string().min(1).max(300), limit: z.number().int().min(1).max(50).optional() }).strict(),
        run: async (a: { product_text: string; limit?: number }, ctx) => {
          need(ctx);
          const act = await active();
          const product = modelProductIn(a.product_text, [...act.models, ...act.notUsed].map((m) => m.product));
          if (!product) return { text: `Which product? The model covers ${act.models.map((m) => m.product.toLowerCase()).join(', ')}.`, suggestions: act.models.slice(0, 3).map((m) => `Who will open ${m.product.toLowerCase()} next?`) };
          const weak = act.notUsed.find((m) => m.product === product);
          if (weak) return { text: `DI doesn’t use its ${product.toLowerCase()} model: on months it never saw it ranked who would open one only a little better than chance (AUC ${weak.metrics.auc.toFixed(2)}, below ${NEXT_PRODUCT_MIN_AUC.toFixed(2)}). The member data doesn’t show those openings coming.`, suggestions: ['How good is the next-best-product model?'] };
          const top = await svc.top(product, { limit: a.limit ?? 15, purviewBranches: ctx.purviewBranches });
          if (!top || !top.items.length) return { text: `No one in your purview stands out for ${product.toLowerCase()} this month.` };
          const show = names(ctx);
          const who = (x: (typeof top.items)[number]) => (show ? x.name : `…${String(x.partyId).slice(-4).padStart(4, '0')}`);
          const first = top.items[0]!;
          return {
            text: `For **${product.toLowerCase()}**, the model’s likeliest at the ${top.month ? modelMonthLabel(top.month) : 'latest'} month-end is **${who(first)}** (${first.branch}), ${first.lift.toFixed(0)} times as likely as average to open one by the next month-end: ${first.drivers.join('; ').toLowerCase() || 'a mix of small signs'}. On months it never saw, the ${pct(top.model.metrics.captured10)} of openers it caught in its top 10% is the measure of how far to trust a list like this.${show ? '' : ' Names are hidden: member details aren’t part of your access.'}`,
            blocks: [moduleTable(spec, `Likeliest to open ${product.toLowerCase()}`, ctx.runId, 'nbp.top', [text('who', show ? 'Name' : 'Member'), text('branch', 'Branch'), text('chance', 'Chance by next month-end'), text('lift', 'Against average'), text('why', 'Why'), { field: 'deposits', headerName: 'Deposits', type: 'currency' }], top.items.map((x) => ({ who: who(x), branch: x.branch, chance: pct(x.probability, 1), lift: `${x.lift.toFixed(1)}×`, why: x.drivers.join('; ') || '—', deposits: x.deposits })))],
            suggestions: ['How good is the next-best-product model?'],
          };
        },
      },
      {
        name: 'nbp_retrain',
        description: 'Prepare training a new version of the next-best-product model on the latest history, one model per product, as a candidate checked on the last three months. It isn’t used until approved. Returns approval_required.',
        input: z.object({}).strict(),
        run: async (_: unknown, ctx) => {
          need(ctx);
          const a = await svc.active();
          const months = await svc.months();
          const next = Math.max(0, ...(await svc.models()).map((x) => x.version)) + 1;
          return {
            change: {
              summary: `Train next-best-product model v${next} as a candidate`,
              changes: [
                { label: 'Learns from', before: a ? `${modelMonthLabel(a.models[0]!.trainFrom)} to ${modelMonthLabel(a.models[0]!.trainTo)}` : '—', after: `${modelMonthLabel(months[0]!)} to ${modelMonthLabel(months.at(-5)!)}` },
                { label: 'Checked on', before: a ? `${modelMonthLabel(a.models[0]!.validFrom)} to ${modelMonthLabel(a.models[0]!.validTo)}` : '—', after: `${modelMonthLabel(months.at(-4)!)} to ${modelMonthLabel(months.at(-2)!)}` },
                { label: 'Used for suggestions', before: a ? `v${a.version}` : '—', after: a ? `Still v${a.version} until v${next} is approved` : `v${next} once approved` },
              ],
              text: `I’ll train next-best-product model **v${next}**, one model per product, on the latest history and check each on the three most recent months with outcomes. It becomes a candidate: nothing changes until someone other than you approves putting it to work. Training takes a minute or two.`,
              done: `Trained next-best-product model v${next} as a candidate.`,
              risk: 'low',
              apply: { by: ctx.user.name },
            },
          };
        },
        apply: async (p: { by: string }) => {
          const t = await svc.train(p.by);
          return {
            text: `Next-best-product model **v${t.version}** is trained: ${t.products.map((x) => `${x.product} AUC ${x.auc.toFixed(2)}`).join(', ')}.${t.weak.length ? ` Not used: ${t.weak.map((x) => `${x.product} (${x.auc.toFixed(2)})`).join(', ')}.` : ''}${t.skipped.length ? ` Too few openings to learn from: ${t.skipped.join(', ')}.` : ''} It’s a candidate: ask to put v${t.version} to work, and someone other than you approves it.`,
            suggestions: [`Put next-best-product model version ${t.version} to work`],
          };
        },
      },
      {
        name: 'nbp_promote',
        description: 'Prepare putting a candidate version of the next-best-product model to work: it replaces the one in use and rescores every member. Needs someone other than the requester to approve. Returns approval_required.',
        input: z.object({ version: z.number().int().positive().optional() }).strict(),
        run: async (a: { version?: number }, ctx) => {
          need(ctx);
          const all = await svc.models();
          const v = a.version ?? all.find((x) => x.status === 'Candidate')?.version;
          const set = all.filter((x) => x.version === v && x.status !== 'Not used');
          if (!v || !set.length) throw new CoreError('NOT_FOUND', a.version ? `There’s no next-best-product model v${a.version}.` : 'There’s no candidate version waiting. Ask me to retrain the next-best-product model first.');
          if (set.every((x) => x.status === 'Active')) throw new CoreError('INVALID', `v${v} is already the model in use.`);
          const cur = await svc.active();
          const avg = (ms: ProductModel[], f: (m: ProductModel) => number) => (ms.length ? ms.reduce((s, m) => s + f(m), 0) / ms.length : 0);
          return {
            change: {
              summary: `Put next-best-product model v${v} to work${cur ? ` in place of v${cur.version}` : ''}`,
              changes: [
                { label: 'Model in use', before: cur ? `v${cur.version}` : '—', after: `v${v}` },
                { label: 'Products it suggests', before: cur ? String(cur.models.length) : '—', after: String(set.length) },
                { label: 'Average AUC', before: cur ? avg(cur.models, (m) => m.metrics.auc).toFixed(2) : '—', after: avg(set, (m) => m.metrics.auc).toFixed(2) },
                { label: 'Average top 10% caught', before: cur ? pct(avg(cur.models, (m) => m.metrics.captured10)) : '—', after: pct(avg(set, (m) => m.metrics.captured10)) },
                { label: 'Trained by', before: '—', after: set[0]!.trainedBy },
              ],
              text: `I’ll put next-best-product model **v${v}** to work${cur ? ` in place of v${cur.version}` : ''} and rescore every member. Model risk policy: someone other than the person asking approves a model before it’s used.`,
              done: `Next-best-product model v${v} is in use.`,
              risk: 'medium',
              secondApprover: { role: 'Someone other than the requester, such as the chief risk officer or the CEO', policy: 'Model risk management: a model is approved by someone other than the person who asked for it before it is used.' },
              apply: { version: v },
            },
          };
        },
        apply: async (p: { version: number }, meta, ctx) => {
          const r = await svc.activate(p.version, ctx.user.name, meta.approvalId);
          return { text: `Next-best-product model **v${p.version}** is in use, approved by ${ctx.user.name}: ${n(r.scored)} suggestions for ${n(r.members)} members at the ${modelMonthLabel(r.month)} month-end.`, suggestions: ['How good is the next-best-product model?'] };
        },
      },
    ],
  };
  return spec;
}
