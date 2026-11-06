// The demo servicer spreadsheet as an Excel file, the way a servicer sends it: one sheet, a header row,
// dates as dates and money as numbers.
import ExcelJS from 'exceljs';

export async function offcoreWorkbook(demo: { name: string; headers: string[]; rows: (string | number | null)[][] }): Promise<Buffer> {
  const wb = new ExcelJS.Workbook();
  wb.creator = 'Servicer report';
  const ws = wb.addWorksheet('Loans');
  ws.addRow(demo.headers).font = { bold: true };
  const dateCols = new Set(demo.headers.map((h, i) => (/date/i.test(h) ? i : -1)).filter((i) => i >= 0));
  for (const r of demo.rows) ws.addRow(r.map((v, i) => (v !== null && dateCols.has(i) ? new Date(`${v}T00:00:00Z`) : v)));
  demo.headers.forEach((h, i) => {
    const col = ws.getColumn(i + 1);
    col.width = Math.max(12, h.length + 2);
    if (dateCols.has(i)) col.numFmt = 'mm/dd/yyyy';
    if (/balance/i.test(h)) col.numFmt = '#,##0.00';
  });
  ws.getColumn(2).width = 32;
  ws.getColumn(3).width = 24;
  return Buffer.from(await wb.xlsx.writeBuffer());
}
