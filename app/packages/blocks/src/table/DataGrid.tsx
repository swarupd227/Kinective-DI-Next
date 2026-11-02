// Shared AG Grid host for in-canvas table blocks and workspace grids (FE-GEN-004, spec 8.11).
// AG Grid's JS theming injects <style> tags, which style-src 'self' forbids (spec 11.9), so the grid
// uses the static Quartz stylesheet with its variables mapped to design tokens in DataGrid.module.css.
import 'ag-grid-community/styles/ag-grid.min.css';
import 'ag-grid-community/styles/ag-theme-quartz.min.css';
import { useMemo } from 'react';
import clsx from 'clsx';
import { AgGridReact } from 'ag-grid-react';
import {
  CellStyleModule,
  ClientSideRowModelModule,
  ModuleRegistry,
  QuickFilterModule,
  RowAutoHeightModule,
  TextFilterModule,
  NumberFilterModule,
  ValidationModule,
  type ColDef,
} from 'ag-grid-community';
import { usePreferences } from '@dinext/ui';
import { formatValue, type ColumnType } from '../format.ts';
import styles from './DataGrid.module.css';

ModuleRegistry.registerModules([
  ClientSideRowModelModule,
  CellStyleModule,
  QuickFilterModule,
  RowAutoHeightModule,
  TextFilterModule,
  NumberFilterModule,
  ...(import.meta.env.DEV ? [ValidationModule] : []),
]);

const numeric = new Set<ColumnType>(['number', 'currency', 'percent', 'bp', 'count', 'days']);
const ROW_HEIGHT = { comfortable: 40, compact: 28 } as const;

export interface GridColumn {
  field: string;
  headerName: string;
  type?: ColumnType;
  pinned?: 'left' | 'right';
  hidden?: boolean;
  width?: number;
}

const WRAP_MAX_ROWS = 100;
/** Rough width of one character of grid text, and a cell's side padding, to size columns. */
const CHAR_PX = 8;
const CELL_PADDING_PX = 34;

export interface DataGridProps {
  columns: GridColumn[];
  rows: Record<string, string | number | boolean | null>[];
  sort?: { field: string; dir: 'asc' | 'desc' }[];
  /** 'auto' grows with the rows (small in-canvas tables); 'fill' takes the container height. */
  layout?: 'auto' | 'fill';
  filters?: boolean;
  quickFilter?: string;
  ariaLabel: string;
}

export default function DataGrid({ columns, rows, sort, layout = 'auto', filters = false, quickFilter, ariaLabel }: DataGridProps) {
  const { density, resolvedTheme } = usePreferences();

  const columnDefs = useMemo<ColDef[]>(
    () =>
      columns.map((c) => {
        const type = c.type ?? 'text';
        const isNum = numeric.has(type);
        // Long text gets more of the width, so it wraps less than the short columns beside it.
        const sample = rows.slice(0, WRAP_MAX_ROWS);
        const longest = isNum ? 0 : Math.max(0, ...sample.map((r) => String(r[c.field] ?? '').length));
        const format = (v: unknown) => formatValue(v as number | null, type, { decimals: type === 'percent' ? 2 : undefined });
        // The widest thing that can't break: a whole number, or the longest single word.
        const unbroken = Math.max(0, ...sample.map((r) => (isNum ? format(r[c.field]).length : Math.max(0, ...String(r[c.field] ?? '').split(/\s+/).map((w) => w.length)))));
        return {
          field: c.field,
          headerName: c.headerName,
          pinned: c.pinned,
          hide: c.hidden,
          width: c.width,
          flex: c.width ? undefined : Math.min(3, Math.max(1, Math.round(longest / 16))),
          // A column narrows only as far as its widest number or word, so values are never cut to "…";
          // a crowded grid scrolls sideways instead.
          minWidth: Math.min(200, Math.max(64, Math.round(unbroken * CHAR_PX) + CELL_PADDING_PX)),
          sort: sort?.find((s) => s.field === c.field)?.dir,
          type: isNum ? 'rightAligned' : undefined,
          // A column's own cellClass replaces the one from its type, so the alignment is repeated here.
          cellClass: isNum ? ['dn-num', 'ag-right-aligned-cell'] : undefined,
          // A long name wraps rather than cutting off. A very large grid keeps its rows even, to stay fast.
          wrapText: !isNum && rows.length <= WRAP_MAX_ROWS,
          autoHeight: !isNum && rows.length <= WRAP_MAX_ROWS,
          filter: filters ? (isNum ? 'agNumberColumnFilter' : 'agTextColumnFilter') : false,
          valueFormatter: isNum ? (p) => format(p.value) : undefined,
        };
      }),
    [columns, rows, sort, filters],
  );

  return (
    <div
      role="region"
      aria-label={ariaLabel}
      className={clsx('ag-theme-quartz', resolvedTheme === 'dark' && 'ag-theme-quartz-dark', styles.grid, layout === 'fill' && styles.fill)}
    >
      <AgGridReact
        theme="legacy"
        rowData={rows}
        columnDefs={columnDefs}
        rowHeight={ROW_HEIGHT[density]}
        headerHeight={ROW_HEIGHT[density]}
        domLayout={layout === 'auto' ? 'autoHeight' : 'normal'}
        defaultColDef={{ sortable: true, resizable: true, suppressMovable: true, wrapHeaderText: true, autoHeaderHeight: true }}
        quickFilterText={quickFilter}
        ensureDomOrder
        suppressDragLeaveHidesColumns
        enableCellTextSelection
        animateRows={false}
      />
    </div>
  );
}
