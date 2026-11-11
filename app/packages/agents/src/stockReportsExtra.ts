// Three more of DI's stock reports, as report sections a run computes: cross-sell (products per person,
// by branch and age, product penetration), attrition (risk by branch and the reasons behind it), and
// the financial statements (balance sheet, income statement, budget against actual) from the GL.
import type { Block, DiTake } from '@dinext/block-schemas';
import { CoreError, type CrossSellService, type GlService, type PredictiveService } from '@dinext/di-core';
import { moduleTable } from './moduleAgent.ts';
import type { ReportAnalyses } from './report.ts';

const text = (field: string, headerName: string) => ({ field, headerName, type: 'text' as const });
const cnt = (field: string, headerName: string) => ({ field, headerName, type: 'count' as const });
const cur = (field: string, headerName: string) => ({ field, headerName, type: 'currency' as const });
const p1 = (n: number) => `${n.toFixed(1)}%`;
const mm = (n: number) => (Math.abs(n) >= 1e9 ? `$${(n / 1e9).toFixed(2)}B` : Math.abs(n) >= 1e6 ? `$${(n / 1e6).toFixed(1)}M` : `$${Math.round(n).toLocaleString('en-US')}`);

export const STOCK_EXTRA_SECTIONS = ['xsell.distribution', 'xsell.branch', 'xsell.age', 'xsell.penetration', 'attr.branch', 'attr.reasons', 'fin.bs', 'fin.is', 'fin.budget'] as const;

export function stockExtraAnalyses(deps: { crossSell: CrossSellService; predictive: PredictiveService; gl: GlService | null }, person: 'member' | 'customer'): ReportAnalyses {
  const P = person === 'member' ? 'Members' : 'Customers';
  const who = (agent: string, ref: string) => ({ agent, sources: [{ kind: 'table' as const, label: 'From the core', ref }] });
  return {
    keys: [...STOCK_EXTRA_SECTIONS],
    async run(key, runId): Promise<{ block: Block; take?: DiTake }> {
      const t = (agent: string, ref: string, title: string, op: string, cols: Parameters<typeof moduleTable>[4], rows: Record<string, string | number>[]) => moduleTable(who(agent, ref), title, runId, op, cols, rows);
      if (key.startsWith('xsell.')) {
        const s = await deps.crossSell.summary({});
        if (key === 'xsell.distribution')
          return {
            block: t('Cross-sell', 'table:cdm_party', `${P} by number of products`, 'report.xsell.distribution', [text('products', 'Products'), cnt('people', P), text('share', 'Share')], s.distribution.map((d) => ({ products: d.products, people: d.people, share: p1(d.sharePct) }))),
            take: { headline: `${s.people.toLocaleString('en-US')} ${person}s hold ${s.perPerson} products each on average; ${p1(s.singlePct)} hold only one.`.slice(0, 300), action: { label: 'Who has only one product?', ask: `Build an audience of ${person}s with only one product` } },
          };
        if (key === 'xsell.branch') return { block: t('Cross-sell', 'table:cdm_party', 'Products per person, by branch', 'report.xsell.branch', [text('name', 'Branch'), cnt('people', P), text('per', 'Products each'), text('single', 'One product'), text('three', 'Three or more')], s.byBranch.map((r) => ({ name: r.name, people: r.people, per: r.perPerson.toFixed(2), single: p1(r.singlePct), three: p1(r.threePlusPct) }))) };
        if (key === 'xsell.age') return { block: t('Cross-sell', 'table:cdm_party', 'Products per person, by age', 'report.xsell.age', [text('name', 'Age'), cnt('people', P), text('per', 'Products each'), text('single', 'One product'), text('three', 'Three or more')], s.byAge.map((r) => ({ name: r.name, people: r.people, per: r.perPerson.toFixed(2), single: p1(r.singlePct), three: p1(r.threePlusPct) }))) };
        const pen = await deps.crossSell.penetration({});
        return { block: t('Cross-sell', 'table:cdm_party', 'Product penetration', 'report.xsell.penetration', [text('product', 'Product'), cnt('people', P), text('share', `Share of ${person}s`)], pen.map((r) => ({ product: r.product, people: r.people, share: p1(r.sharePct) }))) };
      }
      if (key === 'attr.branch') {
        const b = await deps.crossSell.attritionByBranch({});
        const high = b.reduce((s, r) => s + r.high, 0);
        const dep = b.reduce((s, r) => s + r.highDeposits, 0);
        return {
          block: t('Attrition', 'table:cdm_attrition_score', 'Attrition risk by branch', 'report.attr.branch', [text('branch', 'Branch'), cnt('high', 'High (7+)'), cnt('medium', 'Medium (5 to 6)'), cnt('low', 'Low'), text('share', 'High share'), cur('deposits', 'Deposits at High risk')], b.map((r) => ({ branch: r.branch, high: r.high, medium: r.medium, low: r.low, share: p1(r.highPct), deposits: r.highDeposits }))),
          take: { headline: `${high.toLocaleString('en-US')} ${person}s are at High risk of leaving, holding ${mm(dep)} in deposits.`.slice(0, 300), action: { label: 'Who is most likely to leave?', ask: 'Who does the attrition model say will leave?' } },
        };
      }
      if (key === 'attr.reasons') {
        const r = await deps.predictive.rootCauses({});
        return { block: t('Attrition', 'table:cdm_attrition_score', 'Why people are at risk', 'report.attr.reasons', [text('factor', 'Reason'), cnt('high', 'High band'), cnt('medium', 'Medium band'), text('share', 'Share of High band'), cur('deposits', 'Deposits held')], r.rows.map((x) => ({ factor: x.factor, high: x.high, medium: x.medium, share: p1(x.highSharePct), deposits: x.deposits }))) };
      }
      if (key.startsWith('fin.')) {
        if (!deps.gl) throw new CoreError('NOT_FOUND', 'The general ledger isn’t loaded for this institution.');
        if (key === 'fin.budget') {
          const b = await deps.gl.budget({ ytd: true });
          const rows = b.lines;
          return { block: t('General Ledger', 'table:gl_balance_month', 'Budget against actual, year to date', 'report.fin.budget', [text('name', 'Department'), text('type', 'Type'), cur('actual', 'Actual'), cur('budget', 'Budget'), cur('variance', 'Variance')], rows.map((r) => ({ name: r.name, type: r.type, actual: Math.round(r.actual), budget: Math.round(r.budget), variance: Math.round(r.variance) }))) };
        }
        const kind = key === 'fin.bs' ? 'BS' : 'IS';
        const s = await deps.gl.statement(kind, { compare: kind === 'BS' ? 'prior_year_end' : 'prior_month' });
        const cols = [text('group', 'Line'), ...s.periods.map((p, i) => cur(`v${i}`, p))];
        const rows = s.groups.map((g) => ({ group: `${g.side}: ${g.group}`, ...Object.fromEntries(g.values.map((v, i) => [`v${i}`, Math.round(v)])) }));
        const tot = s.totals as unknown as Record<string, number[] | undefined>;
        for (const [k, label] of kind === 'BS' ? [['assets', 'Total assets'], ['liabilities', 'Total liabilities'], ['equity', 'Total equity']] : [['income', 'Total income'], ['expenses', 'Total expenses'], ['net', 'Net income']]) rows.push({ group: label!, ...Object.fromEntries((tot[k!] ?? []).map((v, i) => [`v${i}`, Math.round(v)])) });
        const block = t('General Ledger', 'table:gl_balance_month', kind === 'BS' ? 'Balance sheet' : 'Income statement', `report.fin.${kind.toLowerCase()}`, cols, rows as Record<string, string | number>[]);
        if (kind === 'BS') return { block, take: { headline: `Total assets ${mm(tot.assets?.[0] ?? 0)}, liabilities ${mm(tot.liabilities?.[0] ?? 0)} and equity ${mm(tot.equity?.[0] ?? 0)}. ${s.scope}`.slice(0, 300), action: { label: 'Show the income statement', ask: 'Show the income statement for the latest month' } } };
        return { block };
      }
      throw new CoreError('NOT_FOUND', `There’s no section ${key}.`);
    },
  };
}
