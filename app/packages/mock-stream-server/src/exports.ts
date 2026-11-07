// Report exports (spec 18.6): rendered from the same canvas the user saw, under their purview.
// Excel: a summary sheet of DI's read and the headline figures, then one sheet per table or chart,
// numbers stored as numbers with formats. CSV: the same sections one after another. PDF: a
// print-ready pack for a board or an examiner, with DI's read, each section's table or chart, its
// source and data date, and a confidentiality footer on every page.
import ExcelJS from 'exceljs';
import PDFDocument from 'pdfkit';
import type { ReportCanvasBlock } from '@dinext/block-schemas';

type Cell = string | number | null;
interface Section {
  title: string;
  /** DI's read of the section, when its analysis gave one. */
  take?: string;
  columns: { header: string; format?: string; type?: string }[];
  rows: Cell[][];
}

const FORMATS: Record<string, string> = { currency: '"$"#,##0', count: '#,##0', number: '#,##0.##', percent: '0.00"%"', bp: '0" bp"' };
const plain = (s: string) => s.replace(/\*\*/g, '');

function sections(canvas: ReportCanvasBlock): { summary: Cell[][]; reads: [string, string][]; sections: Section[] } {
  const summary: Cell[][] = [];
  const reads: [string, string][] = [];
  const out: Section[] = [];
  if (canvas.data.take) reads.push(['DI’s read', plain(canvas.data.take.headline)]);
  for (const w of canvas.data.widgets) {
    const v = w.view;
    const take = w.take ? plain(w.take.headline) : undefined;
    if (take && take !== reads[0]?.[1]) reads.push([w.title, take]);
    if (v.type === 'kpi') {
      summary.push([w.title, v.data.value, v.data.unit, v.data.comparison ? `${v.data.comparison.value} ${v.data.comparison.unit ?? ''} ${v.data.comparison.label}`.replace(/\s+/g, ' ') : null]);
    } else if (v.type === 'table') {
      const cols = v.data.columns.filter((c) => !c.hidden);
      out.push({ title: w.title, take, columns: cols.map((c) => ({ header: c.headerName, format: FORMATS[c.type], type: c.type })), rows: (v.data.rows ?? []).map((r) => cols.map((c) => r[c.field] ?? null) as Cell[]) });
    } else if (v.type === 'chart') {
      const unit = v.data.axes?.y?.[0]?.unit;
      out.push({ title: w.title, take, columns: v.data.dataset.dimensions.map((d, i) => ({ header: d.displayName ?? d.name, format: i === 0 ? undefined : FORMATS[unit ?? 'number'], type: i === 0 ? 'text' : (unit ?? 'number') })), rows: v.data.dataset.source as Cell[][] });
    } else if (v.type === 'notice') {
      summary.push([w.title, null, null, v.data.message]);
    }
  }
  return { summary, reads, sections: out };
}

const safeName = (s: string) => s.replace(/[^A-Za-z0-9 _-]+/g, '').trim().slice(0, 60) || 'report';

export async function renderExport(canvas: ReportCanvasBlock, format: 'xlsx' | 'csv' | 'pdf', meta: { tenant: string; user: string }) {
  const { summary, reads, sections: parts } = sections(canvas);
  const scope = canvas.subtitle ?? canvas.data.periodLabel;
  // The build time in the institution's own time zone, as it was recorded.
  const asOf = canvas.freshness.asOf ? canvas.freshness.asOf.slice(0, 16).replace('T', ' ') : '';
  const header = [`${meta.tenant}`, `${canvas.data.name}: ${scope}`, `Nightly build ${canvas.freshness.buildId ?? ''} (${asOf}). Exported by ${meta.user}. Limited to their access.`];
  const base = `${safeName(canvas.data.name)} ${safeName(canvas.data.periodLabel)}`;

  if (format === 'pdf') return { fileName: `${base}.pdf`, contentType: 'application/pdf', body: await renderPdf(canvas, { ...meta, scope, asOf }) };

  if (format === 'csv') {
    const esc = (v: Cell) => (v === null ? '' : typeof v === 'number' ? String(v) : /[",\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v);
    const lines = [...header.map((h) => esc(h)), ''];
    if (reads.length) lines.push('DI’s read', ...reads.map(([t, r]) => [t, r].map(esc).join(',')), '');
    if (summary.length) lines.push('Summary', 'Measure,Value,Unit,Change', ...summary.map((r) => r.map(esc).join(',')), '');
    for (const s of parts) lines.push(esc(s.title), ...(s.take ? [esc(s.take)] : []), s.columns.map((c) => esc(c.header)).join(','), ...s.rows.map((r) => r.map(esc).join(',')), '');
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
  if (reads.length) {
    top.addRow(['DI’s read']).font = { bold: true };
    for (const [t, r] of reads) {
      const row = top.addRow([t, r]);
      row.getCell(2).alignment = { wrapText: true, vertical: 'top' };
    }
    top.addRow([]);
  }
  top.addRow(['Measure', 'Value', 'Unit', 'Change']).font = { bold: true };
  for (const r of summary) {
    const row = top.addRow(r);
    const unit = r[2];
    if (typeof unit === 'string' && FORMATS[unit]) row.getCell(2).numFmt = FORMATS[unit]!;
  }
  top.columns = [{ width: 32 }, { width: reads.length ? 90 : 18 }, { width: 10 }, { width: 40 }];
  for (const s of parts) {
    const ws = wb.addWorksheet(sheetName(s.title, used));
    ws.addRow([s.title]).font = { bold: true, size: 12 };
    const lead = s.take ? 3 : 2;
    if (s.take) ws.addRow([s.take]).font = { italic: true };
    ws.addRow(s.columns.map((c) => c.header)).font = { bold: true };
    for (const r of s.rows) ws.addRow(r);
    s.columns.forEach((c, i) => {
      const col = ws.getColumn(i + 1);
      col.width = Math.max(14, c.header.length + 4);
      if (c.format) col.numFmt = c.format;
    });
    ws.views = [{ state: 'frozen', ySplit: lead }];
  }
  const body = Buffer.from(await wb.xlsx.writeBuffer());
  return { fileName: `${base}.xlsx`, contentType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', body };
}

// ---- PDF ----------------------------------------------------------------------------------------

/** The standard PDF fonts cover Windows-1252 only, so a few typographic characters become plain ones. */
const pdfText = (s: string) =>
  plain(s)
    .replace(/[−–]/g, '-')
    .replace(/≥/g, '>=')
    .replace(/≤/g, '<=')
    .replace(/→/g, '->')
    .replace(/×/g, 'x')
    .replace(/[^\x20-\x7e\u00a0-\u00ff\u2018\u2019\u201c\u201d\u2014\u2022\u2026\u20ac]/g, '');

const INK = '#1f2a37';
const MUTED = '#5b6675';
const RULE = '#d5dbe3';
const SHADE = '#eef2f6';
const ACCENT = '#00707f';
const PALETTE = ['#00707f', '#3b6fb6', '#8a5cc2', '#c26b2b', '#2f8f5b', '#b0475f'];

const usd = (v: number, compact = false) => {
  if (compact && Math.abs(v) >= 1e6) return `${v < 0 ? '-' : ''}$${(Math.abs(v) / 1e9 >= 1 ? `${(Math.abs(v) / 1e9).toFixed(2)}B` : `${(Math.abs(v) / 1e6).toFixed(1)}M`)}`;
  return `${v < 0 ? '-' : ''}$${Math.round(Math.abs(v)).toLocaleString('en-US')}`;
};
const fmt = (v: Cell, type?: string, compact = false): string => {
  if (v === null || v === '') return '-';
  if (typeof v !== 'number') return pdfText(String(v));
  switch (type) {
    case 'currency':
      return usd(v, compact);
    case 'percent':
      return `${v.toFixed(2)}%`;
    case 'bp':
      return `${Math.round(v)} bp`;
    case 'count':
      return Math.round(v).toLocaleString('en-US');
    case 'days':
      return `${Math.round(v)} days`;
    default:
      return Number.isInteger(v) ? v.toLocaleString('en-US') : v.toLocaleString('en-US', { maximumFractionDigits: 2 });
  }
};

async function renderPdf(canvas: ReportCanvasBlock, meta: { tenant: string; user: string; scope: string; asOf: string }): Promise<Buffer> {
  const doc = new PDFDocument({ size: 'LETTER', margins: { top: 54, bottom: 64, left: 54, right: 54 }, bufferPages: true, info: { Title: pdfText(canvas.data.name), Author: 'Kinective Data Intelligence', Subject: pdfText(meta.scope) } });
  const chunks: Buffer[] = [];
  doc.on('data', (c: Buffer) => chunks.push(c));
  const done = new Promise<Buffer>((resolve) => doc.on('end', () => resolve(Buffer.concat(chunks))));

  const left = doc.page.margins.left;
  const width = doc.page.width - left - doc.page.margins.right;
  const bottom = () => doc.page.height - doc.page.margins.bottom;
  const room = (h: number) => {
    if (doc.y + h > bottom() && doc.y > doc.page.margins.top + 1) doc.addPage();
  };

  // Title block.
  doc.font('Helvetica').fontSize(9).fillColor(MUTED).text(pdfText(meta.tenant.toUpperCase()), left, doc.y, { width, characterSpacing: 0.6 });
  doc.moveDown(0.3);
  doc.font('Helvetica-Bold').fontSize(20).fillColor(INK).text(pdfText(canvas.data.name), { width });
  doc.font('Helvetica').fontSize(11).fillColor(MUTED).text(pdfText(meta.scope), { width });
  if (canvas.data.description) {
    doc.moveDown(0.4);
    doc.fontSize(9.5).fillColor(MUTED).text(pdfText(canvas.data.description), { width });
  }
  doc.moveDown(0.4);
  doc.fontSize(8.5).fillColor(MUTED).text(pdfText(`Data as of nightly build ${meta.asOf}${canvas.freshness.buildId ? ` (${canvas.freshness.buildId})` : ''}. Prepared by DI for ${meta.user}, limited to their access.`), { width });
  doc.moveDown(0.8);

  // DI's read of the whole report.
  if (canvas.data.take) {
    const text = pdfText(canvas.data.take.headline);
    doc.font('Helvetica').fontSize(10.5);
    const h = doc.heightOfString(text, { width: width - 28 }) + 30;
    room(h);
    const y = doc.y;
    doc.rect(left, y, width, h).fill('#e8f6f7');
    doc.rect(left, y, 3, h).fill(ACCENT);
    doc.font('Helvetica-Bold').fontSize(8).fillColor(ACCENT).text('DI’S READ', left + 14, y + 8, { width: width - 28, characterSpacing: 0.6 });
    doc.font('Helvetica').fontSize(10.5).fillColor(INK).text(text, left + 14, y + 20, { width: width - 28 });
    doc.y = y + h + 14;
  }

  // Headline figures, three to a row.
  const kpis = canvas.data.widgets.filter((w) => w.view.type === 'kpi');
  if (kpis.length) {
    const cols = Math.min(3, kpis.length);
    const cw = (width - (cols - 1) * 10) / cols;
    for (let i = 0; i < kpis.length; i += cols) {
      room(58);
      const y = doc.y;
      kpis.slice(i, i + cols).forEach((w, j) => {
        const v = w.view as Extract<ReportCanvasBlock['data']['widgets'][number]['view'], { type: 'kpi' }>;
        const x = left + j * (cw + 10);
        doc.rect(x, y, cw, 50).lineWidth(0.75).strokeColor(RULE).stroke();
        doc.font('Helvetica').fontSize(8).fillColor(MUTED).text(pdfText(w.title), x + 8, y + 7, { width: cw - 16, height: 10, ellipsis: true });
        doc.font('Helvetica-Bold').fontSize(15).fillColor(INK).text(fmt(v.data.value, v.data.unit, true), x + 8, y + 19, { width: cw - 16 });
        if (v.data.comparison) {
          const c = v.data.comparison;
          doc.font('Helvetica').fontSize(7.5).fillColor(MUTED).text(pdfText(`${c.value > 0 ? '+' : ''}${fmt(c.value, c.unit ?? v.data.unit, true)} ${c.label}`), x + 8, y + 37, { width: cw - 16, height: 10, ellipsis: true });
        }
      });
      doc.y = y + 60;
    }
    doc.moveDown(0.4);
  }

  // Each section: title, DI's read, then its table or chart, then where it came from.
  for (const w of canvas.data.widgets) {
    const v = w.view;
    if (v.type === 'kpi') continue;
    // A title stays with its chart: room for the whole chart before the title goes down.
    room(v.type === 'chart' ? 250 : 60);
    doc.x = left;
    doc.font('Helvetica-Bold').fontSize(12.5).fillColor(INK).text(pdfText(w.title), left, doc.y, { width });
    if (v.subtitle) doc.font('Helvetica').fontSize(8.5).fillColor(MUTED).text(pdfText(v.subtitle), { width });
    if (w.take && w.take.headline !== canvas.data.take?.headline) {
      doc.moveDown(0.2);
      doc.font('Helvetica-Oblique').fontSize(9.5).fillColor(INK).text(pdfText(w.take.headline), { width });
    }
    doc.moveDown(0.4);
    if (v.type === 'table') {
      const cols = v.data.columns.filter((c) => !c.hidden);
      drawTable(
        doc,
        cols.map((c) => ({ header: c.headerName, type: c.type })),
        (v.data.rows ?? []).map((r) => cols.map((c) => (r[c.field] ?? null) as Cell)),
        left,
        width,
        bottom,
      );
    } else if (v.type === 'chart') {
      drawChart(doc, v.data, left, width, room);
    } else if (v.type === 'text') {
      doc.font('Helvetica').fontSize(10).fillColor(INK).text(pdfText(v.data.markdown), { width });
    } else if (v.type === 'notice') {
      doc.font('Helvetica-Oblique').fontSize(9.5).fillColor(MUTED).text(pdfText(v.data.message), { width });
    }
    const sources = v.provenance.sources.map((s) => s.label).filter(Boolean);
    const asOf = v.freshness.kind === 'nightly_build' && v.freshness.asOf ? v.freshness.asOf.slice(0, 10) : '';
    if (sources.length || asOf) {
      doc.moveDown(0.3);
      doc.font('Helvetica').fontSize(7.5).fillColor(MUTED).text(pdfText([sources.length ? `Source: ${sources.join(', ')}` : '', asOf ? `data as of ${asOf}` : ''].filter(Boolean).join(' · ')), left, doc.y, { width });
    }
    doc.moveDown(1.1);
  }

  // Every page: who it's for, that it's confidential, and where it sits in the pack.
  const range = doc.bufferedPageRange();
  for (let i = range.start; i < range.start + range.count; i++) {
    doc.switchToPage(i);
    const keep = doc.page.margins.bottom;
    doc.page.margins.bottom = 0;
    const y = doc.page.height - 40;
    doc.moveTo(left, y - 6).lineTo(left + width, y - 6).lineWidth(0.5).strokeColor(RULE).stroke();
    doc.font('Helvetica').fontSize(7.5).fillColor(MUTED);
    doc.text(pdfText(`Confidential: ${meta.tenant}. ${canvas.data.name}, ${meta.scope}. Prepared by Kinective DI for ${meta.user}.`), left, y, { width: width - 70, lineBreak: false, ellipsis: true });
    doc.text(`Page ${i - range.start + 1} of ${range.count}`, left + width - 70, y, { width: 70, align: 'right', lineBreak: false });
    doc.page.margins.bottom = keep;
  }
  doc.end();
  return done;
}

type Doc = InstanceType<typeof PDFDocument>;

/** A table that wraps its text, repeats its header on a new page and right-aligns numbers. */
function drawTable(doc: Doc, columns: { header: string; type?: string }[], rows: Cell[][], left: number, width: number, bottom: () => number) {
  const numeric = (t?: string) => t === 'currency' || t === 'percent' || t === 'count' || t === 'number' || t === 'bp' || t === 'days';
  const size = columns.length > 6 ? 7.5 : 8.5;
  const pad = 4;
  // Widths follow the longest text in each column, numbers kept narrow, within the page.
  const weight = columns.map((c, i) => {
    const longest = Math.max(...rows.slice(0, 80).map((r) => fmt(r[i] ?? null, c.type, true).length));
    // A column is at least as wide as its longest header word, so "Minimum" never breaks.
    const word = Math.max(...c.header.split(/\s+/).map((w) => w.length));
    return Math.max(word + 1, numeric(c.type) ? Math.min(14, Math.max(8, longest)) : Math.min(48, Math.max(8, longest, Math.ceil(c.header.length / 2))));
  });
  const total = weight.reduce((a, b) => a + b, 0);
  const widths = weight.map((w) => (w / total) * width);
  const xs = widths.map((_, i) => left + widths.slice(0, i).reduce((a, b) => a + b, 0));
  // A new page only helps when the row isn't already at the top of one (a very tall row just runs on).
  const atTop = () => doc.y <= doc.page.margins.top + 1;
  const header = () => {
    doc.font('Helvetica-Bold').fontSize(size);
    const h = Math.max(...columns.map((c, i) => doc.heightOfString(pdfText(c.header), { width: widths[i]! - pad * 2 }))) + pad * 2;
    if (doc.y + h > bottom() && !atTop()) doc.addPage();
    const y = doc.y;
    doc.rect(left, y, width, h).fill(SHADE);
    columns.forEach((c, i) => doc.fillColor(INK).text(pdfText(c.header), xs[i]! + pad, y + pad, { width: widths[i]! - pad * 2, align: numeric(c.type) ? 'right' : 'left' }));
    doc.y = y + h;
  };
  header();
  doc.font('Helvetica').fontSize(size);
  for (const r of rows) {
    const texts = columns.map((c, i) => fmt(r[i] ?? null, c.type, true));
    const h = Math.max(...texts.map((t, i) => doc.heightOfString(t, { width: widths[i]! - pad * 2 }))) + pad * 2;
    if (doc.y + h > bottom() && !atTop()) {
      doc.addPage();
      header();
      doc.font('Helvetica').fontSize(size);
    }
    const y = doc.y;
    texts.forEach((t, i) => doc.fillColor(INK).text(t, xs[i]! + pad, y + pad, { width: widths[i]! - pad * 2, align: numeric(columns[i]!.type) ? 'right' : 'left' }));
    doc.moveTo(left, y + h).lineTo(left + width, y + h).lineWidth(0.4).strokeColor(RULE).stroke();
    doc.y = y + h;
  }
  doc.x = left;
}

/** A plain chart: bars (grouped, or stacked for a stacked bar) or lines, with a light grid and a legend. */
function drawChart(doc: Doc, data: Extract<ReportCanvasBlock['data']['widgets'][number]['view'], { type: 'chart' }>['data'], left: number, width: number, room: (h: number) => void) {
  const dims = data.dataset.dimensions.map((d) => d.name);
  const series = data.series.filter((s) => dims.includes(s.encode.y)).slice(0, 6);
  const xDim = series[0]?.encode.x ?? dims[0]!;
  const xi = dims.indexOf(xDim);
  const rows = data.dataset.source.slice(0, 40);
  const unit = data.axes?.y?.[0]?.unit;
  if (!series.length || !rows.length || data.chartType === 'pie' || data.chartType === 'donut' || data.chartType === 'heatmap' || data.chartType === 'scatter') {
    // Charts that don't draw well on paper print as their figures.
    drawTable(doc, data.dataset.dimensions.map((d, i) => ({ header: d.displayName ?? d.name, type: i === xi ? 'text' : unit })), rows as Cell[][], left, width, () => doc.page.height - doc.page.margins.bottom);
    return;
  }
  const h = 170;
  room(h + 40);
  const top = doc.y;
  const axisW = 54;
  const plotX = left + axisW;
  const plotW = width - axisW;
  const plotH = h - 26;
  const values = (s: (typeof series)[number]) => rows.map((r) => Number(r[dims.indexOf(s.encode.y)] ?? 0));
  const stacked = data.chartType === 'stacked_bar';
  const all = stacked ? rows.map((_, i) => series.reduce((a, s) => a + (values(s)[i] ?? 0), 0)) : series.flatMap(values);
  let lo = Math.min(0, ...all);
  let hi = Math.max(...all);
  if (data.chartType === 'line' || data.chartType === 'area') {
    // A line of rates reads its movement: the axis hugs the values instead of starting at zero.
    const span = Math.max(...all) - Math.min(...all) || Math.abs(hi) || 1;
    lo = Math.min(...all) - span * 0.15;
    hi = Math.max(...all) + span * 0.15;
  }
  if (hi === lo) hi = lo + 1;
  const yAt = (v: number) => top + plotH - ((v - lo) / (hi - lo)) * plotH;
  doc.font('Helvetica').fontSize(7).fillColor(MUTED);
  for (let g = 0; g <= 4; g++) {
    const v = lo + ((hi - lo) * g) / 4;
    const y = yAt(v);
    doc.moveTo(plotX, y).lineTo(plotX + plotW, y).lineWidth(0.4).strokeColor(RULE).stroke();
    doc.fillColor(MUTED).text(fmt(v, unit, true), left, y - 4, { width: axisW - 6, align: 'right', lineBreak: false });
  }
  const step = plotW / rows.length;
  const labelEvery = Math.ceil(rows.length / 10);
  rows.forEach((r, i) => {
    if (i % labelEvery) return;
    doc.fillColor(MUTED).text(pdfText(String(r[xi] ?? '')), plotX + i * step, top + plotH + 4, { width: step * labelEvery, align: 'center', height: 18, ellipsis: true });
  });
  if (data.chartType === 'line' || data.chartType === 'area') {
    series.forEach((s, k) => {
      const vs = values(s);
      const color = PALETTE[k % PALETTE.length]!;
      vs.forEach((v, i) => {
        const x = plotX + step * (i + 0.5);
        if (i === 0) doc.moveTo(x, yAt(v));
        else doc.lineTo(x, yAt(v));
      });
      doc.lineWidth(1.6).strokeColor(color).stroke();
      vs.forEach((v, i) => doc.circle(plotX + step * (i + 0.5), yAt(v), 1.8).fill(color));
    });
  } else {
    const groupW = step * 0.7;
    rows.forEach((_, i) => {
      let base = 0;
      series.forEach((s, k) => {
        const v = values(s)[i] ?? 0;
        const color = PALETTE[k % PALETTE.length]!;
        if (stacked) {
          const y0 = yAt(base);
          const y1 = yAt(base + v);
          doc.rect(plotX + step * i + (step - groupW) / 2, Math.min(y0, y1), groupW, Math.abs(y0 - y1)).fill(color);
          base += v;
        } else {
          const bw = groupW / series.length;
          const y0 = yAt(0);
          const y1 = yAt(v);
          doc.rect(plotX + step * i + (step - groupW) / 2 + k * bw, Math.min(y0, y1), Math.max(bw - 1, 1), Math.abs(y0 - y1)).fill(color);
        }
      });
    });
  }
  doc.y = top + h;
  if (series.length > 1) {
    let x = left + axisW;
    doc.font('Helvetica').fontSize(7.5);
    series.forEach((s, k) => {
      const label = pdfText(s.name);
      doc.rect(x, doc.y + 2, 7, 7).fill(PALETTE[k % PALETTE.length]!);
      doc.fillColor(INK).text(label, x + 10, doc.y, { lineBreak: false });
      x += 18 + doc.widthOfString(label);
    });
    doc.y += 14;
  }
  doc.x = left;
}

// ---- one table ----------------------------------------------------------------------------------

export interface TableExport {
  title: string;
  columns: { field: string; headerName: string; type?: string; hidden?: boolean }[];
  rows: Record<string, string | number | boolean | null>[];
  /** Where the table came from and how current it is, as the block said. */
  source?: string;
  asOf?: string;
}

/** A table DI showed, as Excel or CSV: the figures the person saw, numbers kept as numbers. */
export async function renderTableExport(t: TableExport, format: 'xlsx' | 'csv', meta: { tenant: string; user: string }) {
  const cols = t.columns.filter((c) => !c.hidden);
  const rows = t.rows.map((r) => cols.map((c) => { const v = r[c.field]; return typeof v === 'boolean' ? (v ? 'Yes' : 'No') : (v ?? null); }) as Cell[]);
  const header = [meta.tenant, t.title, `${t.source ? `Source: ${t.source}. ` : ''}${t.asOf ? `Data as of ${t.asOf}. ` : ''}Exported by ${meta.user}. Limited to their access.`];
  const base = safeName(t.title);
  if (format === 'csv') {
    const esc = (v: Cell) => (v === null ? '' : typeof v === 'number' ? String(v) : /[",\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v);
    const lines = [...header.map(esc), '', cols.map((c) => esc(c.headerName)).join(','), ...rows.map((r) => r.map(esc).join(','))];
    return { fileName: `${base}.csv`, contentType: 'text/csv; charset=utf-8', body: Buffer.from(`${String.fromCharCode(0xfeff)}${lines.join('\r\n')}`, 'utf8') };
  }
  const wb = new ExcelJS.Workbook();
  wb.creator = 'Kinective DI Next';
  wb.created = new Date();
  const ws = wb.addWorksheet(t.title.replace(/[\\/*?:[\]]/g, ' ').slice(0, 28) || 'Table');
  header.forEach((h, i) => (ws.getCell(i + 1, 1).value = h));
  ws.getRow(2).font = { bold: true, size: 12 };
  ws.addRow([]);
  ws.addRow(cols.map((c) => c.headerName)).font = { bold: true };
  for (const r of rows) ws.addRow(r);
  cols.forEach((c, i) => {
    const col = ws.getColumn(i + 1);
    col.width = Math.max(14, c.headerName.length + 4);
    const f = c.type ? FORMATS[c.type] : undefined;
    if (f) col.numFmt = f;
  });
  ws.views = [{ state: 'frozen', ySplit: 4 }];
  return { fileName: `${base}.xlsx`, contentType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', body: Buffer.from(await wb.xlsx.writeBuffer()) };
}
