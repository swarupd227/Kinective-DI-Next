// Workbench cases: each block type in each standard state (spec 10.5, FE-ARCH-100).
import type { Block, StreamingEnvelope } from '@dinext/block-schemas';
import type { FrameStatus } from '@dinext/blocks';
import {
  approvalHighFixture,
  approvalMediumFixture,
  chartFixture,
  kpiFixture,
  kpiGroupFixture,
  lineChartFixture,
  member360Fixture,
  memberCardFixture,
  noticeFixtures,
  planStepsFixture,
  reportCanvasFixture,
  tableFixture,
  textFixture,
} from '@dinext/block-schemas/fixtures';

export type CaseState = 'complete' | 'loading' | 'streaming' | 'empty' | 'stale' | 'resolved' | 'expired' | 'invalid';

export interface Variant {
  state: CaseState;
  label: string;
  block: Block | StreamingEnvelope;
  status: FrameStatus;
}

export interface Case {
  id: string;
  label: string;
  group: 'Data' | 'Conversation' | 'Action' | 'States';
  description: string;
  variants: Variant[];
}

const shell = (b: Block): StreamingEnvelope => ({ ...b, data: {} });
const stale = <B extends Block>(b: B): B => ({ ...b, freshness: { ...b.freshness, asOf: '2026-10-24T04:12:00-04:00', stale: true } });

const loading = (b: Block): Variant => ({ state: 'loading', label: 'Loading', block: shell(b), status: 'loading' });
const complete = (b: Block): Variant => ({ state: 'complete', label: 'Complete', block: b, status: 'complete' });
const invalid = (b: Block): Variant => ({
  state: 'invalid',
  label: 'Fails validation',
  block: { ...b, data: { ...b.data, formatter: 'function(){}' } } as unknown as Block,
  status: 'complete',
});

export function buildCases(): Case[] {
  const medium = approvalMediumFixture();
  const high = approvalHighFixture();
  return [
    {
      id: 'text',
      label: 'Text',
      group: 'Conversation',
      description: 'Restricted Markdown. Raw HTML is stripped and links are limited to DI Next deep links and Kinective help (FE-GEN-010).',
      variants: [
        complete(textFixture),
        { state: 'streaming', label: 'Streaming', block: { ...textFixture, data: { markdown: textFixture.data.markdown.slice(0, 120) } }, status: 'streaming' },
        loading(textFixture),
      ],
    },
    {
      id: 'kpi',
      label: 'KPI',
      group: 'Data',
      description: 'Value, change with direction in icon and words, sparkline and a link to the definition.',
      variants: [complete(kpiFixture), loading(kpiFixture), { state: 'stale', label: 'Stale build', block: stale(kpiFixture), status: 'complete' }],
    },
    {
      id: 'member_card',
      label: 'Member card',
      group: 'Data',
      description: 'Who the member is, what they hold and their scores with "Why?". In a pick list it shows only the masked number and branch (AI-AGT-150, AI-AGT-151).',
      variants: [complete(memberCardFixture), { state: 'complete', label: 'Pick list', block: { ...memberCardFixture, data: { ...memberCardFixture.data, selected: false, badges: [], scores: [], nextBest: [] } }, status: 'complete' }, loading(memberCardFixture)],
    },
    {
      id: 'report_canvas',
      label: 'Report canvas',
      group: 'Data',
      description: 'A report on a 12-column grid. Controls re-run it in place; an agent change is outlined with Accept and Revert (spec 8.9, FE-BLD-003).',
      variants: [complete(reportCanvasFixture), { state: 'complete', label: 'Read mode', block: { ...reportCanvasFixture, data: { ...reportCanvasFixture.data, mode: 'read', status: 'stock', pendingEdits: [], widgets: reportCanvasFixture.data.widgets.map(({ editId: _e, ...w }) => w) } }, status: 'complete' }, loading(reportCanvasFixture)],
    },
    {
      id: 'member_360',
      label: 'Member 360',
      group: 'Data',
      description: 'Every Relationship Dashboard section as keyboard tabs. Opportunities carry Refer and Member declined (FE-RM-001, FE-RM-004).',
      variants: [complete(member360Fixture), loading(member360Fixture)],
    },
    {
      id: 'kpi_group',
      label: 'KPI group',
      group: 'Data',
      description: '"What changed since the last build" on Home. Favourable and unfavourable changes follow each metric\'s goodWhen.',
      variants: [complete(kpiGroupFixture), loading(kpiGroupFixture)],
    },
    {
      id: 'chart_bar',
      label: 'Chart: bar',
      group: 'Data',
      description: 'Prior period in the same hue, lighter. Renders only at block.end. Table view for every chart (FE-GEN-002, FE-GEN-041).',
      variants: [
        complete(chartFixture),
        loading(chartFixture),
        { state: 'empty', label: 'Empty', block: { ...chartFixture, data: { ...chartFixture.data, dataset: { ...chartFixture.data.dataset, source: [] } } }, status: 'complete' },
        { state: 'stale', label: 'Stale build', block: stale(chartFixture), status: 'complete' },
        invalid(chartFixture),
      ],
    },
    {
      id: 'chart_line',
      label: 'Chart: line',
      group: 'Data',
      description: 'Dashed prior-year line and a watch-level mark line.',
      variants: [complete(lineChartFixture)],
    },
    {
      id: 'table',
      label: 'Table',
      group: 'Data',
      description: 'AG Grid built from declared columns only; the server never sends grid options (FE-GEN-004).',
      variants: [
        complete(tableFixture),
        loading(tableFixture),
        { state: 'empty', label: 'Empty', block: { ...tableFixture, data: { ...tableFixture.data, rows: [], rowCount: 0 } }, status: 'complete' },
        invalid(tableFixture),
      ],
    },
    {
      id: 'plan_steps',
      label: 'Plan steps',
      group: 'Action',
      description: 'A multi-step run with live elapsed time, expandable operations and Stop (spec 6.8, 6.11).',
      variants: [
        complete(planStepsFixture),
        {
          state: 'resolved',
          label: 'Completed',
          block: {
            ...planStepsFixture,
            data: {
              ...planStepsFixture.data,
              state: 'completed',
              steps: planStepsFixture.data.steps.map((s, i) => ({
                ...s,
                state: 'done',
                startedAt: s.startedAt ?? '2026-10-26T14:03:04Z',
                endedAt: `2026-10-26T14:03:0${6 + i}Z`,
                resultSummary: s.resultSummary ?? 'Done',
              })),
            },
          },
          status: 'complete',
        },
        { state: 'loading', label: 'Loading', block: shell(planStepsFixture), status: 'loading' },
      ],
    },
    {
      id: 'approval_medium',
      label: 'Approval: medium',
      group: 'Action',
      description: 'Click or keyboard confirm; voice only after read-back when the tenant allows it (spec 6.10).',
      variants: [
        complete(medium),
        { state: 'resolved', label: 'Approved', block: { ...medium, data: { ...medium.data, resolution: { decision: 'approved', by: 'Dana Lee', at: '2026-10-26T14:05:00Z', channel: 'click' } } }, status: 'complete' },
        { state: 'expired', label: 'Expired', block: { ...medium, data: { ...medium.data, expiresAt: '2026-10-26T10:00:00Z' } }, status: 'complete' },
        { state: 'loading', label: 'Loading', block: shell(medium), status: 'loading' },
      ],
    },
    {
      id: 'approval_high',
      label: 'Approval: high',
      group: 'Action',
      description: 'Typed key value, step-up sign-in, second approver and a required note. Never by voice (FE-EXP-081, FE-EXP-082).',
      variants: [complete(high)],
    },
    {
      id: 'notices',
      label: 'Notices',
      group: 'States',
      description: 'No access, no data, error with reference ID, clarification, stale build and beta (spec 10.5).',
      variants: noticeFixtures.map((n) => ({ state: 'complete' as const, label: n.data.kind.replace('_', ' '), block: n, status: 'complete' as const })),
    },
    {
      id: 'unknown',
      label: 'Unknown type',
      group: 'States',
      description: 'A block type the client does not know is never rendered; a notice is shown instead (spec 9.1).',
      variants: [
        {
          state: 'invalid',
          label: 'Unknown type',
          block: { ...textFixture, type: 'hologram', data: { html: '<img src=x onerror=alert(1)>' } } as unknown as Block,
          status: 'complete',
        },
        { state: 'invalid', label: 'Newer major', block: { ...textFixture, version: '3.0.0' }, status: 'complete' },
      ],
    },
  ];
}
