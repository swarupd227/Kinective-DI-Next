// The Dashboards launcher (today's DI home): every table, form and report this person can open, in
// one searchable grid with Tables / Forms / Reports chips. It lists what the person's access
// already allows; opening a card goes to that page, and DI can be asked about any of them there.
import { useMemo, useState } from 'react';
import { Link } from 'react-router';
import { useQuery } from '@tanstack/react-query';
import clsx from 'clsx';
import { FileBarChart, LayoutGrid, Search, SquarePen, Table2 } from 'lucide-react';
import { TextInput } from '@dinext/ui';
import { useSession } from '../session/SessionProvider.tsx';
import { APP_META } from '../shell/apps.tsx';
import styles from './HomeLauncher.module.css';

type Kind = 'Table' | 'Form' | 'Report';
interface Card {
  key: string;
  label: string;
  kinds: Kind[];
  link: string;
  detail?: string;
}

/** Module pages as today's DI lists them: a workflow is a table you can also submit a form to. */
const MODULE_KINDS: Record<string, Kind[]> = {
  rm: ['Table'],
  referrals: ['Table', 'Form'],
  tasks: ['Table', 'Form'],
  datalogs: ['Table', 'Form'],
  compliance: ['Report', 'Form'],
  lap: ['Report'],
  gi: ['Report'],
  indirect: ['Report'],
  prospecting: ['Report'],
  campaigns: ['Report'],
  onboarding: ['Report'],
  predictive: ['Report'],
  seg: ['Report'],
  callreport: ['Report'],
  dq: ['Report'],
};
const FIRST = 12;
const ICON: Record<Kind, typeof Table2> = { Table: Table2, Form: SquarePen, Report: FileBarChart };

export function HomeLauncher() {
  const { api, session } = useSession();
  const apps = session.apps as string[];
  const reports = useQuery({ queryKey: ['reports'], queryFn: () => api.reports(), enabled: apps.includes('reports') });
  const tables = useQuery({ queryKey: ['search', 'tables'], queryFn: () => api.search('tables'), enabled: apps.includes('tables') });
  const [q, setQ] = useState('');
  const [only, setOnly] = useState<Kind | null>(null);
  const [all, setAll] = useState(false);

  const cards = useMemo(() => {
    const out: Card[] = [];
    const bank = session.tenant.institutionType === 'bank';
    for (const [app, kinds] of Object.entries(MODULE_KINDS)) {
      const meta = APP_META[app];
      if (!meta || !apps.includes(app)) continue;
      const label = app === 'rm' ? (bank ? 'Customers' : 'Members') : app === 'compliance' ? 'Compliance issues' : meta.label;
      out.push({ key: `app:${app}`, label, kinds, link: meta.path, detail: kinds.includes('Report') && !kinds.includes('Form') ? 'Dashboard' : undefined });
    }
    for (const t of reports.data?.templates ?? []) if (t.status !== 'draft') out.push({ key: `rpt:${t.templateId}`, label: t.name, kinds: ['Report'], link: `/reports/${t.templateId}`, detail: t.folder });
    for (const t of tables.data ?? []) if (t.kind === 'table' || t.kind === 'view') out.push({ key: `tbl:${t.id}`, label: t.label, kinds: ['Table'], link: t.link, detail: t.detail });
    const seen = new Set<string>();
    return out.filter((c) => !seen.has(c.link) && seen.add(c.link));
  }, [apps, reports.data, tables.data, session.tenant.institutionType]);

  // Each word matches the start of a word, so "board" finds Board report, not every Dashboard.
  const words = q.toLowerCase().split(/\s+/).filter(Boolean);
  const startsWord = (text: string, w: string) => text.split(/[^a-z0-9$%]+/).some((t) => t.startsWith(w));
  const shown = cards.filter((c) => (!only || c.kinds.includes(only)) && words.every((w) => startsWord(`${c.label} ${c.detail ?? ''} ${c.kinds.join(' ')}`.toLowerCase(), w)));
  const count = (k: Kind) => cards.filter((c) => c.kinds.includes(k)).length;
  const filtering = Boolean(words.length || only);
  const visible = all || filtering ? shown : shown.slice(0, FIRST);

  if (!cards.length) return null;
  return (
    <section className={styles.launcher} aria-labelledby="h-dashboards">
      <div className={styles.head}>
        <h2 id="h-dashboards" className={styles.title}>
          <LayoutGrid size={16} aria-hidden /> Browse
        </h2>
        <TextInput label="Search dashboards" hideLabel placeholder="Search dashboards" leading={<Search size={14} aria-hidden />} value={q} onChange={(e) => setQ(e.target.value)} className={styles.search} />
        <div className={styles.chips} role="group" aria-label="Show only">
          {(['Table', 'Form', 'Report'] as Kind[]).map((k) => (
            <button key={k} type="button" aria-pressed={only === k} className={clsx(styles.chip, only === k && styles.chipOn)} onClick={() => setOnly(only === k ? null : k)}>
              <span className={styles.chipCount}>{count(k)}</span> {k}s
            </button>
          ))}
        </div>
      </div>
      {shown.length === 0 ? (
        <p className={styles.empty}>Nothing matches. Try other words, or ask DI to find it.</p>
      ) : (
        <ul className={styles.grid}>
          {visible.map((c) => {
            const Icon = ICON[c.kinds[0]!];
            return (
              <li key={c.key}>
                <Link to={c.link} className={styles.card}>
                  <span className={clsx(styles.icon, styles[`icon${c.kinds[0]}`])}>
                    <Icon size={16} aria-hidden />
                  </span>
                  <span className={styles.label}>{c.label}</span>
                  {c.detail && <span className={styles.detail}>{c.detail}</span>}
                  <span className={styles.tags}>
                    {c.kinds.map((k) => (
                      <span key={k} className={styles.tag}>
                        {k}
                      </span>
                    ))}
                  </span>
                </Link>
              </li>
            );
          })}
        </ul>
      )}
      {!filtering && shown.length > FIRST && (
        <button type="button" className={styles.more} onClick={() => setAll(!all)}>
          {all ? 'Show fewer' : `Show all ${shown.length}`}
        </button>
      )}
    </section>
  );
}
