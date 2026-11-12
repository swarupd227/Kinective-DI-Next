// A branch manager's Home: their branch against the CEO's six targets, and the operations items
// worth opening today. Code computes every figure from BranchKpiService; each item opens the Branch
// Performance question that explains it.
import { randomBytes } from 'node:crypto';
import type { KpiGroupBlock, ListBlock } from '@dinext/block-schemas';
import { BRANCH_TARGETS, BRANCH_MEASURES, LOBBY_WAIT_TARGET, type BranchKpiService, type BranchMeasure } from '@dinext/di-core';

type Item = KpiGroupBlock['data']['items'][number];
type Row = ListBlock['data']['items'][number];

const UNIT: Record<BranchMeasure, Pick<Item, 'unit' | 'format'>> = {
  depositGrowthPct: { unit: 'percent', format: { decimals: 1 } },
  loanGrowthPct: { unit: 'percent', format: { decimals: 1 } },
  newMembersPerMonth: { unit: 'number', format: { decimals: 1 } },
  productsPerMember: { unit: 'number', format: { decimals: 2 } },
  nps: { unit: 'number', format: { decimals: 0 } },
  dq30Pct: { unit: 'percent', format: { decimals: 2 } },
};

/** The gap to the target's edge that matters: the floor for growth, members, products and NPS; the ceiling for delinquency. */
export function targetGap(measure: BranchMeasure, value: number): NonNullable<Item['comparison']> {
  const t = BRANCH_TARGETS[measure];
  const ceiling = t.low === null;
  const edge = (ceiling ? t.high : t.low) as number;
  // The gap is shown to the measure's own precision: NPS in whole points, products per member to two places.
  const scale = 10 ** (UNIT[measure].format?.decimals ?? 2);
  const gap = Math.round((value - edge) * scale) / scale;
  return { label: `vs target ${t.target}`.slice(0, 60), value: gap, unit: UNIT[measure].unit, direction: gap > 0 ? 'up' : gap < 0 ? 'down' : 'flat', goodWhen: ceiling ? 'down' : 'up' };
}

const newId = () => `blk_${randomBytes(12).toString('hex').slice(0, 16)}`;
const ask = (q: string) => `/c/new?q=${encodeURIComponent(q)}`;
const ONE = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

/**
 * The CEO's targets as figures and the branch's operations as a list, for one branch. Null when the
 * branch isn't found or its operations tables aren't there yet (a tenant seeded before they existed).
 */
export interface BranchHome {
  title: string;
  kpis: KpiGroupBlock;
  ops: ListBlock;
}

export async function branchHome(svc: BranchKpiService, branch: string, base: KpiGroupBlock): Promise<BranchHome | null> {
  const scope = { branches: [branch] };
  const [targets, balancing, lobby, audits, people] = await Promise.all([svc.targets(scope), svc.balancing(scope), svc.lobby(scope), svc.audits(scope), svc.people(scope)]);
  const line = targets.lines.find((l) => l.branch === branch);
  if (!line) return null;
  const items: Item[] = BRANCH_MEASURES.map((m) => ({ label: BRANCH_TARGETS[m].label, value: Math.round(line[m] * 100) / 100, ...UNIT[m], comparison: targetGap(m, line[m]) }));
  const met = line.scores.filter((s) => s.met).length;
  const kpis: KpiGroupBlock = {
    ...base,
    id: newId(),
    title: undefined,
    actions: undefined,
    provenance: {
      agent: 'Branch Performance',
      sources: [
        { kind: 'table', label: 'Month-end balances, members and delinquency by branch', ref: 'table:hist_loan_month' },
        { kind: 'table', label: 'Member surveys', ref: 'table:cdm_survey' },
      ],
      filters: [`${branch}, ${targets.label}`],
    },
    data: { layout: 'grid', items },
  };

  const rows: Row[] = [];
  const bal = balancing.lines.find((l) => l.branch === branch);
  if (bal) {
    const worst = balancing.people.filter((p) => p.branch === branch && p.outOfBalance > 0).sort((a, b) => b.outOfBalance - a.outOfBalance)[0];
    const flagged = bal.outOfBalance > 0 || bal.vaultOverLimitDays > 0;
    rows.push({
      id: 'balancing',
      icon: flagged ? 'alert' : 'task',
      title: `Teller balancing: ${bal.balancedPct.toFixed(1)}% of drawers balanced`,
      subtitle: [worst ? `${worst.name} out of balance ${ONE(worst.outOfBalance, 'time', 'times')}` : 'Every drawer balanced', bal.vaultOverLimitDays ? `vault over its limit ${ONE(bal.vaultOverLimitDays, 'day', 'days')}` : null].filter(Boolean).join('; ') + `, last ${balancing.days} days.`,
      link: ask('Show teller balancing and the vault for my branch'),
      ...(flagged ? { badge: { label: 'Look', tone: 'warning' as const } } : {}),
    });
  }
  const lob = lobby.lines.find((l) => l.branch === branch);
  if (lob) {
    const slow = lob.busiest && lob.busiest.avgWait > LOBBY_WAIT_TARGET;
    rows.push({
      id: 'lobby',
      icon: 'clock',
      title: `Lobby wait: ${lob.avgWait.toFixed(1)} minutes on average`,
      subtitle: lob.busiest ? `${lob.busiest.day} at ${lob.busiest.hour % 12 || 12}${lob.busiest.hour < 12 ? 'am' : 'pm'} averages ${lob.busiest.avgWait.toFixed(1)} minutes, against the ${LOBBY_WAIT_TARGET}-minute target.` : `Against the ${LOBBY_WAIT_TARGET}-minute target.`,
      link: ask('What are lobby wait times at my branch?'),
      ...(slow ? { badge: { label: 'Over at peak', tone: 'warning' as const } } : {}),
    });
  }
  const aud = audits.lines.find((l) => l.branch === branch);
  if (aud) {
    rows.push({
      id: 'audit',
      icon: aud.pastDue ? 'alert' : 'report',
      title: `Audit: ${ONE(aud.open, 'open exception', 'open exceptions')}${aud.pastDue ? `, ${aud.pastDue} past due` : ''}`,
      subtitle: `${ONE(aud.counts, 'surprise cash count', 'surprise cash counts')}${aud.countsWithDifference ? `, ${aud.countsWithDifference} with a difference` : ''}${aud.countsWithoutDualControl ? `, ${aud.countsWithoutDualControl} without dual control` : ''}.`,
      link: ask('Show audit exceptions and surprise cash counts'),
      ...(aud.pastDue ? { badge: { label: 'Past due', tone: 'danger' as const } } : {}),
    });
  }
  const ppl = people.lines.find((l) => l.branch === branch);
  if (ppl) {
    rows.push({
      id: 'people',
      icon: 'member',
      title: `Required training: ${ppl.trainingPct.toFixed(1)}% complete`,
      subtitle: `${ppl.trainingOverdue ? `${ONE(ppl.trainingOverdue, 'course', 'courses')} overdue. ` : ''}Turnover ${ppl.turnoverPct.toFixed(0)}% (${ppl.left} of ${ppl.headcount}) over the last 12 months.`,
      link: ask('Show training completion and turnover for my branch'),
      ...(ppl.trainingOverdue ? { badge: { label: 'Overdue', tone: 'warning' as const } } : {}),
    });
  }
  const ops: ListBlock = {
    id: newId(),
    type: 'list',
    version: '1.0.0',
    provenance: { agent: 'Branch Performance', sources: [{ kind: 'table', label: 'Teller, vault, lobby, audit and training records', ref: 'table:bro_teller_day' }], filters: [branch] },
    freshness: base.freshness,
    data: { layout: 'list', items: rows },
  };
  return { title: `${branch}: ${met} of ${BRANCH_MEASURES.length} CEO targets met`, kpis, ops };
}
