// A workflow form as people will see it (spec 8.22): tabs of sections, with what a proposed change
// adds or moves marked. Read only: layout changes are asked for in the conversation and approved.
import { useState } from 'react';
import clsx from 'clsx';
import { Calendar, ChevronDown, DollarSign, Paperclip, User } from 'lucide-react';
import type { FormBlock } from '@dinext/block-schemas';
import styles from './FormPreviewView.module.css';

type Field = FormBlock['data']['tabs'][number]['sections'][number]['fields'][number];

const MARK: Record<NonNullable<Field['mark']>, string> = { added: 'New', moved: 'Moved', changed: 'Changed' };
const STATE: Record<FormBlock['data']['state'], string> = { live: 'Live form', draft: 'Draft form', proposed: 'Proposed form' };

function Control({ f }: { f: Field }) {
  if (f.type === 'file')
    return (
      <span className={clsx(styles.control, styles.drop)}>
        <Paperclip size={14} aria-hidden /> Attach a file
      </span>
    );
  const Icon = f.type === 'enum' ? ChevronDown : f.type === 'date' ? Calendar : f.type === 'person' ? User : f.type === 'money' ? DollarSign : null;
  return <span className={styles.control}>{Icon && <Icon size={14} aria-hidden className={f.type === 'money' ? undefined : styles.trail} />}</span>;
}

export function FormPreviewView({ block }: { block: FormBlock }) {
  const d = block.data;
  const [tab, setTab] = useState(0);
  const current = d.tabs[Math.min(tab, d.tabs.length - 1)]!;
  const marks = d.tabs.flatMap((t) => t.sections.flatMap((s) => s.fields)).filter((f) => f.mark).length;
  return (
    <div className={styles.form}>
      <p className={styles.head}>
        <strong>{d.workflow}</strong>
        <span className={clsx(styles.state, d.state === 'proposed' && styles.proposed)}>{STATE[d.state]}</span>
        {d.state === 'proposed' && <span className={styles.meta}>{marks ? `${marks} ${marks === 1 ? 'field' : 'fields'} marked` : 'Layout only'}. Nothing changes until you approve the card.</span>}
      </p>
      {d.tabs.length > 1 && (
        <div role="tablist" aria-label={`${d.workflow} form tabs`} className={styles.tabs}>
          {d.tabs.map((t, i) => (
            <button key={t.title} type="button" role="tab" aria-selected={i === tab} className={clsx(styles.tab, i === tab && styles.tabOn)} onClick={() => setTab(i)}>
              {t.title}
            </button>
          ))}
        </div>
      )}
      <div role={d.tabs.length > 1 ? 'tabpanel' : undefined} className={styles.panel}>
        {current.sections.map((s) => (
          <fieldset key={s.title} className={styles.section} disabled>
            <legend className={styles.legend}>{s.title}</legend>
            <div className={clsx(styles.grid, s.columns === 2 && styles.two)}>
              {s.fields.map((f) => (
                <div key={f.id} className={clsx(styles.field, f.mark && styles[f.mark])}>
                  <span className={styles.label}>
                    {f.label}
                    {f.mark && <span className={styles.badge}>{MARK[f.mark]}</span>}
                  </span>
                  <Control f={f} />
                  {f.help && <span className={styles.help}>{f.help}</span>}
                </div>
              ))}
              {!s.fields.length && <span className={styles.meta}>No fields in this section yet.</span>}
            </div>
          </fieldset>
        ))}
      </div>
      {d.removed?.length ? <p className={styles.meta}>Removed: {d.removed.join(', ')}</p> : null}
    </div>
  );
}
