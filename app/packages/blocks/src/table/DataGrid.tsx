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
        return {
          field: c.field,
          headerName: c.headerName,
          pinned: c.pinned,
          hide: c.hidden,
          width: c.width,
          flex: c.width ? undefined : 1,
          minWidth: 110,
          sort: sort?.find((s) => s.field === c.field)?.dir,
          type: isNum ? 'rightAligned' : undefined,
          cellClass: isNum ? 'dn-num' : undefined,
          filter: filters ? (isNum ? 'agNumberColumnFilter' : 'agTextColumnFilter') : false,
          valueFormatter: isNum ? (p) => formatValue(p.value as number | null, type, { decimals: type === 'percent' ? 2 : undefined }) : undefined,
        };
      }),
    [columns, sort, filters],
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
        defaultColDef={{ sortable: true, resizable: true, suppressMovable: true }}
        quickFilterText={quickFilter}
        ensureDomOrder
        suppressDragLeaveHidesColumns
        enableCellTextSelection
        animateRows={false}
      />
    </div>
  );
}
