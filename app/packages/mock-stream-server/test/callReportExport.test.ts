// @vitest-environment node
// The Call Report leaves DI as files a person takes to the regulator: an item-and-value data file
// (thousands for the FFIEC report, dollars for the 5300) and a review workbook. Marked DRAFT while
// edits are open.
import { describe, expect, it } from 'vitest';
import ExcelJS from 'exceljs';
import { CallReportService } from '@dinext/di-core';
import { tenantPool, warehouseAvailable } from '@dinext/tenant-db';
import { callReportFile } from '../src/callReportExport.ts';

for (const [schema, name, form, total] of [['dinext_t_test_bank', 'Coastal Community Bank', 'FFIEC051', 'RCON2170'], ['dinext_t_test_cu', 'Harborview Federal Credit Union', '5300', '010']] as const) {
  const up = await warehouseAvailable(schema);
  describe.skipIf(!up)(`the ${form} files`, () => {
    it('give every item with its value as filed, and a workbook for review', async () => {
      const pool = tenantPool(schema);
      try {
        const cr = new CallReportService(pool);
        const lines = await cr.lines();
        const data = await callReportFile(cr, name, 'data');
        expect(data.fileName).toMatch(new RegExp(`^${form} Q3-2026 ${name} DRAFT data\\.csv$`));
        const rows = data.body.toString('utf8').split('\r\n');
        expect(rows[0]).toBe('Item,Value');
        const assets = lines.find((l) => l.code === total)!.current!;
        const filed = Number(rows.find((r) => r.startsWith(`${total},`))!.split(',')[1]);
        expect(filed).toBe(form === '5300' ? Math.round(assets) : Math.round(assets / 1000));
        const review = await callReportFile(cr, name, 'review');
        const wb = new ExcelJS.Workbook();
        await wb.xlsx.load(review.body as unknown as ArrayBuffer);
        expect(wb.worksheets.map((w) => w.name)).toEqual(expect.arrayContaining(['Summary', 'Edits', 'Explanations']));
        expect(String(wb.getWorksheet('Summary')!.getCell('B5').value)).toMatch(/^Draft:/);
      } finally {
        await pool.end();
      }
    });
  });
}
