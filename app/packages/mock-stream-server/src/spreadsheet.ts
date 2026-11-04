// Reads an uploaded Excel workbook for Data Load (di-core ingest.ts). Each sheet becomes its first row
// and the rest, with formulas as their results, dates as yyyy-mm-dd and rich text as plain text.
import ExcelJS from 'exceljs';
import type { Cell, SpreadsheetReader } from '@dinext/di-core';

const plain = (v: ExcelJS.CellValue): Cell => {
  if (v === null || v === undefined) return null;
  if (v instanceof Date) return v.toISOString().slice(0, 10);
  if (typeof v === 'number') return v;
  if (typeof v === 'boolean') return v ? 'Yes' : 'No';
  if (typeof v === 'string') return v;
  if (typeof v === 'object') {
    if ('result' in v) return plain(v.result as ExcelJS.CellValue);
    if ('richText' in v) return v.richText.map((r) => r.text).join('');
    if ('text' in v) return String(v.text);
    if ('error' in v) return null;
  }
  return String(v);
};

export const readWorkbook: SpreadsheetReader = async (body) => {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(body as unknown as ArrayBuffer);
  return wb.worksheets.map((ws) => {
    const grid: Cell[][] = [];
    ws.eachRow({ includeEmpty: false }, (row) => {
      const values = row.values as ExcelJS.CellValue[];
      grid.push(values.slice(1).map(plain));
    });
    return { name: ws.name, headers: (grid[0] ?? []).map((c) => (c === null ? '' : String(c))), rows: grid.slice(1) };
  });
};
