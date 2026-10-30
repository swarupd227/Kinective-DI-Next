import { describe, expect, it } from 'vitest';
import { validateBlock } from '../src/index.ts';
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
} from '../src/fixtures.ts';

const fixtures = [
  reportCanvasFixture,
  memberCardFixture,
  member360Fixture,
  textFixture,
  kpiFixture,
  kpiGroupFixture,
  chartFixture,
  lineChartFixture,
  tableFixture,
  planStepsFixture,
  approvalMediumFixture(),
  approvalHighFixture(),
  ...noticeFixtures,
];

describe('validateBlock', () => {
  it.each(fixtures.map((f) => [f.type, f.id, f] as const))('accepts fixture %s %s', (_t, _id, fixture) => {
    const result = validateBlock(fixture);
    expect(result.ok ? 'ok' : result.issues).toBe('ok');
  });

  it('rejects unknown block types (spec 9.1)', () => {
    const result = validateBlock({ ...textFixture, type: 'iframe' });
    expect(result).toMatchObject({ ok: false, reason: 'unknown_type' });
  });

  it('reports catalogue types this client has not implemented yet', () => {
    expect(validateBlock({ ...textFixture, type: 'map' })).toMatchObject({ ok: false, reason: 'not_implemented' });
  });

  it('rejects an unsupported major version (FE-GEN-050)', () => {
    expect(validateBlock({ ...textFixture, version: '2.0.0' })).toMatchObject({ ok: false, reason: 'unsupported_version' });
  });

  it('rejects chart options that smuggle formatters or raw ECharts config (FE-GEN-003)', () => {
    const withFormatter = { ...chartFixture, data: { ...chartFixture.data, tooltip: { formatter: 'function(p){return p}' } } };
    expect(validateBlock(withFormatter)).toMatchObject({ ok: false, reason: 'invalid' });
    const withFn = { ...chartFixture, data: { ...chartFixture.data, series: [{ ...chartFixture.data.series[0], encode: { x: 'branch', y: () => 1 } }] } };
    expect(validateBlock(withFn)).toMatchObject({ ok: false, reason: 'invalid' });
  });

  it('rejects AG Grid options in a table block (FE-GEN-004)', () => {
    const withGridOptions = { ...tableFixture, data: { ...tableFixture.data, gridOptions: { onCellClicked: 'alert(1)' } } };
    expect(validateBlock(withGridOptions)).toMatchObject({ ok: false, reason: 'invalid' });
  });

  it('rejects unknown envelope properties and malformed ids', () => {
    expect(validateBlock({ ...kpiFixture, html: '<b>x</b>' })).toMatchObject({ ok: false });
    expect(validateBlock({ ...kpiFixture, id: 'blk_short' })).toMatchObject({ ok: false });
  });

  it('enforces size limits (spec 9.3)', () => {
    const tooManyRows = { ...tableFixture, data: { ...tableFixture.data, rows: Array.from({ length: 501 }, () => ({ branch: 'x' })) } };
    expect(validateBlock(tooManyRows)).toMatchObject({ ok: false });
    expect(validateBlock({ ...textFixture, data: { markdown: 'x'.repeat(8001) } })).toMatchObject({ ok: false });
  });

  it('keeps member identifiers masked and record links opaque (AI-AGT-151, FE-ARCH-011)', () => {
    const d = memberCardFixture.data;
    expect(validateBlock({ ...memberCardFixture, data: { ...d, maskedNumber: '10004521' } })).toMatchObject({ ok: false });
    expect(validateBlock({ ...memberCardFixture, data: { ...d, memberRef: '10004521' } })).toMatchObject({ ok: false });
    expect(validateBlock({ ...memberCardFixture, data: { ...d, birthDate: '2004-02-20' } })).toMatchObject({ ok: false });
    expect(validateBlock({ ...memberCardFixture, data: { ...d, scores: [{ ...d.scores[0]!, value: 11 }] } })).toMatchObject({ ok: false });
  });

  it('validates every widget inside a report canvas as the block it is (spec 9.1)', () => {
    const [k] = reportCanvasFixture.data.widgets;
    const bad = { ...reportCanvasFixture, data: { ...reportCanvasFixture.data, widgets: [{ ...k!, view: { ...k!.view, data: { ...k!.view.data, formatter: 'x' } } }] } };
    expect(validateBlock(bad)).toMatchObject({ ok: false, reason: 'invalid' });
    const iframe = { ...reportCanvasFixture, data: { ...reportCanvasFixture.data, widgets: [{ ...k!, view: { ...k!.view, type: 'iframe' } }] } };
    expect(validateBlock(iframe)).toMatchObject({ ok: false });
  });

  it('never lets an approval card be read-tier', () => {
    const card = approvalMediumFixture();
    expect(validateBlock({ ...card, data: { ...card.data, riskTier: 'read' } })).toMatchObject({ ok: false });
  });
});
