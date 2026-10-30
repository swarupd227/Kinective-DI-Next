// Report exports (spec 18.6): rendered from the same canvas the user saw, under their purview.
// Excel: a summary sheet of headline figures and one sheet per table or chart, numbers stored as
// numbers with formats. CSV: the same sections one after another.
import ExcelJS from 'exceljs';
import type { ReportCanvasBlock } from '@dinext/block-schemas';

type Cell = string | number | null;
interface Section {
  title: string;
  columns: { header: string; format?: string }[];
  rows: Cell[][];
}

const FORMATS: Record<string, string> = { currency: '"$"#,##0', count: '#,##0', number: '#,##0.##', percent: '0.00"%"', bp: '0" bp"' };

function sections(canvas: ReportCanvasBlock): { summary: Cell[][]; sections: Section[] } {
  const summary: Cell[][] = [];
  const out: Section[] = [];
  for (const w of canvas.data.widgets) {
    const v = w.view;
    if (v.type === 'kpi') {
      summary.push([w.title, v.data.value, v.data.unit, v.data.comparison ? `${v.data.comparison.value} ${v.data.comparison.unit} ${v.data.comparison.label}` : null]);
    } else if (v.type === 'table') {
      const cols = v.data.columns.filter((c) => !c.hidden);
      out.push({ title: w.title, columns: cols.map((c) => ({ header: c.headerName, format: FORMATS[c.type] })), rows: (v.data.rows ?? []).map((r) => cols.map((c) => r[c.field] ?? null) as Cell[]) });
    } else if (v.type === 'chart') {
      const unit = v.data.axes?.y?.[0]?.unit;
      out.push({ title: w.title, columns: v.data.dataset.dimensions.map((d, i) => ({ header: d.displayName ?? d.name, format: i === 0 ? undefined : FORMATS[unit ?? 'number'] })), rows: v.data.dataset.source as Cell[][] });
    } else if (v.type === 'notice') {
      summary.push([w.title, null, null, v.data.message]);
    }
  }
  return { summary, sections: out };
}

const safeName = (s: string) => s.replace(/[^A-Za-z0-9 _-]+/g, '').trim().slice(0, 60) || 'report';

export async function renderExport(canvas: ReportCanvasBlock, format: 'xlsx' | 'csv', meta: { tenant: string; user: string }) {
  const { summary, sections: parts } = sections(canvas);
  const scope = canvas.subtitle ?? canvas.data.periodLabel;
  // The build time in the institution's own time zone, as it was recorded.
  const asOf = canvas.freshness.asOf ? canvas.freshness.asOf.slice(0, 16).replace('T', ' ') : '';
  const header = [`${meta.tenant}`, `${canvas.data.name}: ${scope}`, `Nightly build ${canvas.freshness.buildId ?? ''} (${asOf}). Exported by ${meta.user}. Limited to their access.`];
  const base = `${safeName(canvas.data.name)} ${safeName(canvas.data.periodLabel)}`;

  if (format === 'csv') {
    const esc = (v: Cell) => (v === null ? '' : typeof v === 'number' ? String(v) : /[",\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v);
    const lines = [...header.map((h) => esc(h)), ''];
    if (summary.length) lines.push('Summary', 'Measure,Value,Unit,Change', ...summary.map((r) => r.map(esc).join(',')), '');
    for (const s of parts) lines.push(esc(s.title), s.columns.map((c) => esc(c.header)).join(','), ...s.rows.map((r) => r.map(esc).join(',')), '');
    // A byte-order mark so Excel opens the UTF-8 file with the right characters.
    const bom = String.fromCharCode(0xfeff);
    return { fileName: `${base}.csv`, contentType: 'text/csv; charset=utf-8', body: Buffer.from(`${bom}${lines.join('\r\n')}`, 'utf8') };
  }

  const wb = new ExcelJS.Workbook();
  wb.creator = 'Kinective DI Next';
  wb.created = new Date();
  const sheetName = (t: string, used: Set<string>) => {
    let n = t.replace(/[\\/*?:[\]]/g, ' ').slice(0, 28) || 'Sheet';
    for (let i = 2; used.has(n); i++) n = `${n.slice(0, 26)} ${i}`;
    used.add(n);
    return n;
  };
  const used = new Set<string>();
  const top = wb.addWorksheet(sheetName('Summary', used));
  header.forEach((h, i) => (top.getCell(i + 1, 1).value = h));
  top.getRow(2).font = { bold: true, size: 13 };
  top.addRow([]);
  top.addRow(['Measure', 'Value', 'Unit', 'Change']).font = { bold: true };
  for (const r of summary) {
    const row = top.addRow(r);
    const unit = r[2];
    if (typeof unit === 'string' && FORMATS[unit]) row.getCell(2).numFmt = FORMATS[unit]!;
  }
  top.columns = [{ width: 32 }, { width: 18 }, { width: 10 }, { width: 40 }];
  for (const s of parts) {
    const ws = wb.addWorksheet(sheetName(s.title, used));
    ws.addRow([s.title]).font = { bold: true, size: 12 };
    ws.addRow(s.columns.map((c) => c.header)).font = { bold: true };
    for (const r of s.rows) ws.addRow(r);
    s.columns.forEach((c, i) => {
      const col = ws.getColumn(i + 1);
      col.width = Math.max(14, c.header.length + 4);
      if (c.format) col.numFmt = c.format;
    });
    ws.views = [{ state: 'frozen', ySplit: 2 }];
  }
  const body = Buffer.from(await wb.xlsx.writeBuffer());
  return { fileName: `${base}.xlsx`, contentType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', body };
}
