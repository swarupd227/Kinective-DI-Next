// report_canvas (spec 8.5, 8.9, 9.4): a report on a 12-column grid. Controls re-run it in place,
// without a conversation turn. In edit mode each widget can be moved, resized or removed, and every
// agent change is highlighted with Accept and Revert until the user decides (FE-BLD-002, FE-BLD-003).
import { useState } from 'react';
import clsx from 'clsx';
import { ArrowDown, ArrowUp, CalendarClock, Check, Download, Maximize2, Minimize2, Save, Trash2, Undo2 } from 'lucide-react';
import type { BlockAction, ReportCanvasBlock, ReportWidgetView } from '@dinext/block-schemas';
import { Badge, Button, IconButton, Menu } from '@dinext/ui';
import { BlockRenderer } from '../BlockRenderer.tsx';
import { useBlockHost, type ReportEditOp } from '../context.tsx';
import styles from './ReportCanvasView.module.css';

const WIDTHS = ['quarter', 'third', 'half', 'full'] as const;
const widthOf = (w: number) => (w <= 3 ? 'quarter' : w <= 4 ? 'third' : w <= 6 ? 'half' : 'full');

export function ReportCanvasView({ block }: { block: ReportCanvasBlock }) {
  const host = useBlockHost();
  // The canvas keeps its own latest run; a new block from the conversation replaces it.
  const [state, setState] = useState({ from: block.id, current: block });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const current = state.from === block.id ? state.current : block;
  if (state.from !== block.id) setState({ from: block.id, current: block });
  const d = current.data;
  const controls = Object.fromEntries(d.controls.map((c) => [c.id, c.value]));
  const editing = d.mode === 'edit';

  const apply = async (p: Promise<ReportCanvasBlock | null> | undefined) => {
    if (!p) return;
    setBusy(true);
    setError(null);
    try {
      const next = await p;
      if (next) setState({ from: block.id, current: next });
      else setError('The report could not be updated. Try again.');
    } catch {
      setError('The report could not be updated. Try again.');
    } finally {
      setBusy(false);
    }
  };
  const rerun = (id: string, value: string) => apply(host.runReport?.(d.templateRef, { ...controls, [id]: value }));
  const edit = (op: ReportEditOp) => apply(host.editReport?.(d.templateRef, op, controls));
  // Saving, scheduling and exporting are writes: they become a request in the conversation, where
  // the agent prepares the approval card (spec 8.5, 8.8).
  const ask = (id: string, label: string, question: string, kind: BlockAction['kind'] = 'ask_followup') => host.onAction?.(current, { id, kind, label, params: { question } });
  const scope = `${d.name}${d.controls.find((c) => c.id === 'node' && c.value !== 'all') ? ` for ${d.controls.find((c) => c.id === 'node')!.value}` : ''}`;
  const removed = d.pendingEdits.filter((e) => !d.widgets.some((w) => w.id === e.widgetId && w.editId === e.id));

  return (
    <div className={styles.report} aria-busy={busy || undefined}>
      <header className={styles.head}>
        <div className={styles.titles}>
          <p className={styles.eyebrow}>
            {d.folder}
            {d.status === 'draft' ? <Badge tone="warning">Draft</Badge> : d.status === 'stock' ? <Badge tone="neutral">Standard</Badge> : <Badge tone="success">Saved</Badge>}
          </p>
          <h3 className={styles.name}>{d.name}</h3>
          {d.description && <p className={styles.description}>{d.description}</p>}
          {d.origin && <p className={styles.origin}>{d.origin}</p>}
        </div>
        <div className={styles.toolbar}>
          {editing && (
            <Button size="sm" variant="primary" icon={<Save size={14} aria-hidden />} onClick={() => ask('save', 'Save', `Save the ${d.name} report in My Reports`)}>
              Save…
            </Button>
          )}
          {!editing && (
            <Menu
              trigger={
                <Button size="sm" icon={<CalendarClock size={14} aria-hidden />}>
                  Schedule
                </Button>
              }
              items={[
                { id: 'weekly', label: 'Every Monday, to me', onSelect: () => ask('schedule', 'Schedule', `Send the ${d.name} report to me every Monday`) },
                { id: 'monthly', label: 'Monthly, business day 1, to me', onSelect: () => ask('schedule', 'Schedule', `Send the ${d.name} report to me monthly on the first business day`) },
                { id: 'daily', label: 'Every business day, to me', onSelect: () => ask('schedule', 'Schedule', `Send the ${d.name} report to me daily`) },
              ]}
            />
          )}
          <Menu
            trigger={
              <Button size="sm" icon={<Download size={14} aria-hidden />}>
                Export
              </Button>
            }
            items={[
              { id: 'xlsx', label: 'Excel (.xlsx)', onSelect: () => ask('export', 'Export', `Export the ${scope} report for ${d.periodLabel} to Excel`, 'export') },
              { id: 'csv', label: 'CSV', onSelect: () => ask('export', 'Export', `Export the ${scope} report for ${d.periodLabel} to CSV`, 'export') },
            ]}
          />
        </div>
      </header>

      {d.controls.length > 0 && (
        <div className={styles.controls} role="group" aria-label="Report controls">
          {d.controls.map((c) => (
            <label key={c.id} className={styles.control}>
              <span>{c.label}</span>
              <select value={c.value} disabled={busy || !host.runReport} onChange={(e) => void rerun(c.id, e.target.value)}>
                {c.options.map((o) => (
                  <option key={o.value} value={o.value}>
                    {o.label}
                  </option>
                ))}
              </select>
            </label>
          ))}
          {busy && (
            <span className={styles.busy} role="status">
              Running…
            </span>
          )}
        </div>
      )}
      {error && (
        <p className={styles.error} role="alert">
          {error}
        </p>
      )}

      {d.pendingEdits.length > 0 && (
        <section className={styles.review} aria-label="Changes to review">
          <p className={styles.reviewTitle}>
            {d.pendingEdits.length} {d.pendingEdits.length === 1 ? 'change' : 'changes'} to review
          </p>
          <ul className={styles.edits}>
            {d.pendingEdits.map((e) => (
              <li key={e.id}>
                <span>{e.summary}</span>
                <span className={styles.editActions}>
                  <Button size="sm" icon={<Check size={14} aria-hidden />} onClick={() => void edit({ kind: 'accept', editId: e.id })} disabled={busy} aria-label={`Accept: ${e.summary}`}>
                    Accept
                  </Button>
                  <Button size="sm" variant="ghost" icon={<Undo2 size={14} aria-hidden />} onClick={() => void edit({ kind: 'revert', editId: e.id })} disabled={busy} aria-label={`Revert: ${e.summary}`}>
                    Revert
                  </Button>
                </span>
              </li>
            ))}
          </ul>
          {removed.length > 0 && <p className={styles.muted}>Removed sections come back if you revert their change.</p>}
        </section>
      )}

      <div className={styles.grid}>
        {d.widgets.map((w, i) => (
          <Widget key={`${w.id}-${w.view.id}`} w={w} index={i} count={d.widgets.length} editing={editing} busy={busy} onEdit={edit} />
        ))}
      </div>

      {d.queries && d.queries.length > 0 && (
        <details className={styles.queries}>
          <summary>Generated queries ({d.queries.length})</summary>
          {d.queries.map((q, i) => (
            <pre key={i} className={styles.sql}>
              <code>{`-- ${q.widgetId}\n${q.sql}`}</code>
            </pre>
          ))}
        </details>
      )}
    </div>
  );
}

function Widget({ w, index, count, editing, busy, onEdit }: { w: ReportWidgetView; index: number; count: number; editing: boolean; busy: boolean; onEdit: (op: ReportEditOp) => void }) {
  const size = widthOf(w.gridPos.w);
  const at = WIDTHS.indexOf(size);
  return (
    <div className={clsx(styles.cell, w.editId && styles.changed)} style={{ ['--span' as string]: w.gridPos.w }} data-widget-id={w.id}>
      {editing && (
        // Keyboard and pointer alternatives to dragging on the grid (spec 10.7, FE-BLD-002).
        <div className={styles.widgetTools} role="toolbar" aria-label={`${w.title} layout`}>
          <IconButton size="sm" label={`Move ${w.title} earlier`} icon={<ArrowUp size={14} aria-hidden />} disabled={busy || index === 0} onClick={() => onEdit({ kind: 'move', widgetId: w.id, position: index - 1 })} />
          <IconButton size="sm" label={`Move ${w.title} later`} icon={<ArrowDown size={14} aria-hidden />} disabled={busy || index === count - 1} onClick={() => onEdit({ kind: 'move', widgetId: w.id, position: index + 1 })} />
          <IconButton size="sm" label={`Make ${w.title} narrower`} icon={<Minimize2 size={14} aria-hidden />} disabled={busy || at === 0} onClick={() => onEdit({ kind: 'resize', widgetId: w.id, size: WIDTHS[at - 1]! })} />
          <IconButton size="sm" label={`Make ${w.title} wider`} icon={<Maximize2 size={14} aria-hidden />} disabled={busy || at === WIDTHS.length - 1} onClick={() => onEdit({ kind: 'resize', widgetId: w.id, size: WIDTHS[at + 1]! })} />
          <IconButton size="sm" label={`Remove ${w.title}`} icon={<Trash2 size={14} aria-hidden />} disabled={busy} onClick={() => onEdit({ kind: 'remove', widgetId: w.id })} />
        </div>
      )}
      <BlockRenderer block={w.view} />
    </div>
  );
}
