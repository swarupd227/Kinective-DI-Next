// @vitest-environment node
// Report and table exports: a PDF pack, DI's read carried into Excel and CSV, and any table DI showed.
import { describe, expect, it } from 'vitest';
import ExcelJS from 'exceljs';
import type { ReportCanvasBlock } from '@dinext/block-schemas';
import { renderExport, renderTableExport } from '../src/exports.ts';

const provenance = { agent: 'Report Builder', runId: 'R-1', operations: ['report.run'], sources: [{ kind: 'table' as const, label: 'FFIEC 051 Call Report values', ref: 'table:cr_value' }] };
const freshness = { kind: 'nightly_build' as const, asOf: '2026-10-26T04:10:00-04:00', buildId: 'bld_20261026' };
const table = (title: string) => ({ id: 'blk_t1', type: 'table' as const, version: '1.0.0', title, provenance, freshness, data: { columns: [{ field: 'ratio', headerName: 'Ratio', type: 'text' as const }, { field: 'now', headerName: 'Now', type: 'percent' as const }, { field: 'above', headerName: 'Above well capitalized', type: 'currency' as const }], rows: [{ ratio: 'CET1 − capital ratio', now: 15.13, above: 74595571 }, { ratio: 'Leverage', now: 10.48, above: 68371777 }], rowCount: 2 } });
const chart = { id: 'blk_c1', type: 'chart' as const, version: '1.0.0', title: 'CET1 by quarter', provenance, freshness, data: { chartType: 'line' as const, dataset: { dimensions: [{ name: 'quarter' }, { name: 'cet1', displayName: 'CET1' }], source: [['Q1 2026', 15.13], ['Q2 2026', 15.05], ['Q3 2026', 15.13]] }, series: [{ name: 'CET1', encode: { x: 'quarter', y: 'cet1' } }], axes: { y: [{ unit: 'percent' as const }] } } };
const canvas = {
  id: 'blk_r1',
  type: 'report_canvas',
  version: '1.0.0',
  title: 'Basel III capital',
  subtitle: 'Q3 2026',
  provenance,
  freshness,
  data: {
    templateRef: 'basel3_capital_quarterly',
    name: 'Basel III capital',
    folder: 'Board',
    status: 'stock',
    mode: 'read',
    version: 1,
    periodLabel: 'Q3 2026',
    take: { headline: 'CET1 15.13%, all well capitalized.' },
    controls: [],
    pendingEdits: [],
    widgets: [
      { id: 'a1', title: 'Basel III ratios', gridPos: { x: 0, y: 0, w: 12, h: 4 }, view: table('Basel III ratios'), take: { headline: 'CET1 15.13%, all well capitalized.' } },
      { id: 'a2', title: 'Stress test', gridPos: { x: 0, y: 4, w: 12, h: 4 }, view: table('Stress test'), take: { headline: 'In a severe downturn CET1 falls to 12.59%.' } },
      { id: 'a3', title: 'CET1 by quarter', gridPos: { x: 0, y: 8, w: 12, h: 4 }, view: chart },
    ],
  },
} as unknown as ReportCanvasBlock;
const meta = { tenant: 'Harborview Bank', user: 'Elena Ortiz' };

describe('report exports', () => {
  it('writes a PDF pack', async () => {
    const f = await renderExport(canvas, 'pdf', meta);
    expect(f.contentType).toBe('application/pdf');
    expect(f.fileName).toBe('Basel III capital Q3 2026.pdf');
    expect(f.body.subarray(0, 5).toString()).toBe('%PDF-');
    expect(f.body.length).toBeGreaterThan(2000);
  });

  it('carries DI’s read into Excel and CSV, once per read', async () => {
    const csv = (await renderExport(canvas, 'csv', meta)).body.toString('utf8');
    expect(csv).toContain('DI’s read');
    expect(csv.match(/CET1 15\.13%, all well capitalized\./g)?.length).toBe(2);
    expect(csv).toContain('In a severe downturn CET1 falls to 12.59%.');
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load((await renderExport(canvas, 'xlsx', meta)).body as never);
    const summary = wb.getWorksheet('Summary')!;
    const cells = summary.getSheetValues().flat().filter((v) => typeof v === 'string') as string[];
    expect(cells).toContain('In a severe downturn CET1 falls to 12.59%.');
  });

  it('exports any table DI showed, numbers kept as numbers', async () => {
    const t = table('Risk-weighted assets').data;
    const x = await renderTableExport({ title: 'Risk-weighted assets', columns: t.columns, rows: t.rows, source: 'FFIEC 051 Call Report values', asOf: '2026-09-30' }, 'xlsx', meta);
    expect(x.fileName).toBe('Risk-weighted assets.xlsx');
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(x.body as never);
    const ws = wb.worksheets[0]!;
    expect(ws.getCell(6, 3).value).toBe(74595571);
    expect(String(ws.getCell(3, 1).value)).toContain('Data as of 2026-09-30');
    const c = (await renderTableExport({ title: 'Risk-weighted assets', columns: t.columns, rows: t.rows }, 'csv', meta)).body.toString('utf8');
    expect(c).toContain('Ratio,Now,Above well capitalized');
    expect(c).toContain('Leverage,10.48,68371777');
  });
});
