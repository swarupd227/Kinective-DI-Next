// The Call Report as files a person takes to the regulator's system. DI prepares and checks the report
// but never submits it; these are what the preparer loads into their Call Report software (or keys
// into CDR or CUOnline) and what the reviewer signs off on.
//
// - The data file: one row per item, the item code and its value as filed. The FFIEC Call Report is
//   reported in thousands of dollars; the NCUA 5300 in whole dollars. Ratios and Yes/No items are as
//   reported. Its layout (Item, Value) is a common import format; the exact layout a given vendor's
//   software or CDR upload expects should be confirmed before it is used for a real filing.
// - The review workbook: a summary with the open edits, every schedule with the prior quarter, the
//   change and the explanation, then the edits and the explanations.
import ExcelJS from 'exceljs';
import type { CallReportLine, CallReportService } from '@dinext/di-core';

export type CallReportFileKind = 'data' | 'review';

const safe = (s: string) => s.replace(/[^\w .()-]/g, '').replace(/\s+/g, ' ').trim();

export async function callReportFile(cr: CallReportService, tenant: string, kind: CallReportFileKind) {
  const [lines, ready, f] = await Promise.all([cr.lines(), cr.readiness(), cr.form()]);
  const q = ready.quarter;
  const ffiec = f.form.startsWith('FFIEC');
  const open = ready.errors.length + ready.warnings.length;
  const status = ready.ready && !ready.warnings.length ? 'Ready to review' : `Draft: ${[ready.errors.length ? `${ready.errors.length} ${ready.errors.length === 1 ? 'edit blocks' : 'edits block'} submission` : '', ready.warnings.length ? `${ready.warnings.length} ${ready.warnings.length === 1 ? 'edit needs' : 'edits need'} an explanation` : ''].filter(Boolean).join('; ')}`;
  const base = `${safe(f.form.replace(/^FFIEC /, 'FFIEC'))} ${q.label.replace(' ', '-')} ${safe(tenant)}${open ? ' DRAFT' : ''}`;
  const ratio = (l: CallReportLine) => Boolean(l.formula && l.formula.includes('/'));
  // As filed: thousands for the FFIEC report, whole dollars for the 5300.
  const filed = (l: CallReportLine, v: number | null) => (v === null ? '' : ratio(l) ? v.toFixed(2) : String(ffiec ? Math.round(v / 1000) : Math.round(v)));
  const valueOf = (l: CallReportLine) => (l.text !== null && l.text !== undefined && l.text !== '' ? l.text : filed(l, l.current));

  if (kind === 'data') {
    const esc = (v: string) => (/[",\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v);
    const rows = lines.filter((l) => l.current !== null || l.text).map((l) => `${l.code},${esc(valueOf(l))}`);
    return { fileName: `${base} data.csv`, contentType: 'text/csv; charset=utf-8', body: Buffer.from(['Item,Value', ...rows].join('\r\n'), 'utf8') };
  }

  const wb = new ExcelJS.Workbook();
  wb.creator = 'Kinective DI Next';
  wb.created = new Date();
  const unit = ffiec ? 'Thousands of dollars' : 'Dollars';
  const summary = wb.addWorksheet('Summary');
  summary.columns = [{ width: 28 }, { width: 90 }];
  const explained = new Map(ready.explanations.map((e) => [e.code, e]));
  [
    ['Institution', tenant],
    ['Report', `${f.form}, ${f.edition}`],
    ['Quarter', `${q.label} (period ending ${q.current})`],
    ['Due', `${q.dueDate} in ${f.filedIn}`],
    ['Status', status],
    ['Amounts', `${unit}; ratios in percent; Yes/No items as answered`],
    ['Prepared by', `DI from the warehouse and general ledger${f.preparer ? `, for ${f.preparer}` : ''}. Submitting it, with the officer’s attestation, stays with a person.`],
    [],
    ['Open edits', ''],
    ...[...ready.errors, ...ready.warnings].map((c) => [`${c.severity === 'Error' ? (ffiec ? 'Validity' : 'Error') : ffiec ? 'Quality' : 'Warning'}${c.editCode ? ` ${c.editCode}` : ''}`, `${c.name}: ${c.detail}`]),
    ...(ready.uncategorized.length ? [[], ['Unmapped GL accounts', ''], ...ready.uncategorized.map((g) => [g.glNumber, `${g.name}: $${g.balance.toLocaleString('en-US')}${g.likelyLine ? ` (likely ${g.likelyLine})` : ''}`])] : []),
  ].forEach((r) => summary.addRow(r));
  summary.getColumn(1).font = { bold: true };

  const schedules = [...new Set(lines.map((l) => l.schedule))];
  for (const sc of schedules) {
    const ls = lines.filter((l) => l.schedule === sc);
    const ws = wb.addWorksheet(safe(sc).slice(0, 31) || 'Schedule');
    ws.columns = [
      { header: 'Item', width: 12 },
      { header: 'Section', width: 26 },
      { header: 'Caption', width: 60 },
      { header: `${q.priorLabel ?? 'Prior'} (${unit.toLowerCase()})`, width: 20 },
      { header: `${q.label} (${unit.toLowerCase()})`, width: 20 },
      { header: 'Change', width: 10 },
      { header: 'How it is built', width: 40 },
      { header: 'Explanation', width: 60 },
    ];
    ws.getRow(1).font = { bold: true };
    for (const l of ls) {
      const e = explained.get(l.code);
      ws.addRow([l.code, l.section, l.name, l.text ? '' : filed(l, l.prior), l.text ? l.text : filed(l, l.current), l.pct === null ? '' : `${l.pct}%`, l.formula ?? l.source, e ? (e.explanation ?? 'Needed') : '']);
    }
    ws.views = [{ state: 'frozen', ySplit: 1 }];
  }

  const edits = wb.addWorksheet('Edits');
  edits.columns = [{ header: 'Edit', width: 14 }, { header: 'Type', width: 10 }, { header: 'Check', width: 60 }, { header: 'Result', width: 8 }, { header: 'Detail', width: 90 }];
  edits.getRow(1).font = { bold: true };
  ready.checks.forEach((c) => edits.addRow([c.editCode ?? '', c.severity === 'Error' ? (ffiec ? 'Validity' : 'Error') : ffiec ? 'Quality' : 'Warning', c.name, c.passed ? 'Passed' : 'Failed', c.detail]));

  const notes = wb.addWorksheet('Explanations');
  notes.columns = [{ header: 'Item', width: 12 }, { header: 'Status', width: 10 }, { header: 'Explanation', width: 90 }, { header: 'Written by', width: 20 }];
  notes.getRow(1).font = { bold: true };
  ready.explanations.forEach((e) => notes.addRow([e.code, e.status, e.explanation ?? '', e.by ?? '']));

  const body = Buffer.from(await wb.xlsx.writeBuffer());
  return { fileName: `${base} review.xlsx`, contentType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', body };
}
