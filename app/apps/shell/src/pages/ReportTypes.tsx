// The report types of today's DI beside the library (spec 8.6–8.8). A table summary is asked of DI,
// which answers from the governed definitions; detail reports open curated tables in the grid; the
// on-demand reports are the module views, run on last night's build.
import { useState } from 'react';
import { Link, useNavigate } from 'react-router';
import { useQuery } from '@tanstack/react-query';
import { ChevronRight, FileBarChart, Sparkles, Table2 } from 'lucide-react';
import { Button } from '@dinext/ui';
import type { AppId } from '@dinext/block-schemas';
import { useSession } from '../session/SessionProvider.tsx';
import styles from './ReportsPage.module.css';

interface Subject {
  label: string;
  measures: { label: string; ask: string }[];
  groups: { label: string; ask: string }[];
}

const subjects = (person: string): Record<string, Subject> => ({
  loans: { label: 'Loans', measures: [{ label: 'Total balance', ask: 'total loan balance' }, { label: 'Number of loans', ask: 'number of open loans' }, { label: 'Delinquency ratio (60+ days)', ask: 'delinquency ratio' }], groups: [{ label: 'Branch', ask: 'branch' }, { label: 'Region', ask: 'region' }, { label: 'Loan category', ask: 'loan category' }] },
  deposits: { label: 'Deposits', measures: [{ label: 'Total balance', ask: 'total deposit balance' }, { label: 'Number of accounts', ask: 'number of deposit accounts' }], groups: [{ label: 'Branch', ask: 'branch' }, { label: 'Region', ask: 'region' }, { label: 'Deposit category', ask: 'deposit category' }] },
  people: { label: person === 'member' ? 'Members' : 'Customers', measures: [{ label: `Number of ${person}s`, ask: `number of ${person}s` }], groups: [{ label: 'Branch', ask: 'branch' }, { label: 'Region', ask: 'region' }] },
});

function Picker({ label, value, options, onChange }: { label: string; value: string; options: { value: string; label: string }[]; onChange: (v: string) => void }) {
  return (
    <label className={styles.field}>
      <span className={styles.detail}>{label}</span>
      <select className={styles.select} value={value} onChange={(e) => onChange(e.target.value)}>
        {options.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </select>
    </label>
  );
}

export function TableSummary() {
  const { startThread, terms } = useSession();
  const navigate = useNavigate();
  const all = subjects(terms.person ?? 'member');
  const [subject, setSubject] = useState('loans');
  const s = all[subject]!;
  const [measure, setMeasure] = useState(0);
  const [group, setGroup] = useState(0);
  const [busy, setBusy] = useState(false);
  const question = `Show ${s.measures[measure]?.ask ?? s.measures[0]!.ask} by ${s.groups[group]?.ask ?? s.groups[0]!.ask}`;
  return (
    <section className={styles.summary} aria-labelledby="ts-title">
      <h2 id="ts-title" className={styles.folderTitle}>
        Table Summary
      </h2>
      <p className={styles.detail}>One measure over one table, grouped. DI answers from the governed definitions, under your access.</p>
      <div className={styles.pickers}>
        <Picker label="Table" value={subject} options={Object.entries(all).map(([value, x]) => ({ value, label: x.label }))} onChange={(v) => { setSubject(v); setMeasure(0); setGroup(0); }} />
        <Picker label="Measure" value={String(measure)} options={s.measures.map((m, i) => ({ value: String(i), label: m.label }))} onChange={(v) => setMeasure(Number(v))} />
        <Picker label="Group by" value={String(group)} options={s.groups.map((g, i) => ({ value: String(i), label: g.label }))} onChange={(v) => setGroup(Number(v))} />
      </div>
      <p className={styles.hint}>
        Asks: “{question}”{' '}
        <Button size="sm" variant="primary" icon={<Sparkles size={14} aria-hidden />} busy={busy} onClick={() => { setBusy(true); void startThread(question).then((id) => navigate(`/c/${id}`), () => setBusy(false)); }}>
          Run
        </Button>
      </p>
    </section>
  );
}

export function DetailReports() {
  const { api } = useSession();
  const tables = useQuery({ queryKey: ['search', 'tables'], queryFn: () => api.search('tables') });
  const list = (tables.data ?? []).filter((t) => t.kind === 'table' || t.kind === 'view');
  return (
    <section aria-labelledby="dr-title">
      <h2 id="dr-title" className={styles.folderTitle}>
        Detail Reports
      </h2>
      <p className={styles.detail}>Row-level lists from curated tables and saved views. Filter and sort in the grid, or ask DI about what you see.</p>
      <ul className={styles.list}>
        {list.map((t) => (
          <li key={t.id}>
            <Link to={t.link} className={styles.item}>
              <Table2 size={18} aria-hidden className={styles.icon} />
              <span className={styles.text}>
                <span className={styles.label}>{t.label}</span>
                {t.detail && <span className={styles.detail}>{t.detail}</span>}
              </span>
              <ChevronRight size={16} aria-hidden className={styles.icon} />
            </Link>
          </li>
        ))}
      </ul>
    </section>
  );
}

const ON_DEMAND: { app: AppId; name: string; detail: string; to: string }[] = [
  { app: 'lap', name: 'Current Loan App Pipeline Summary', detail: 'Applications by stage and product, with what’s stalled.', to: '/m/lap' },
  { app: 'predictive', name: 'High Scoring Products and Attrition', detail: 'Who is likely to leave, and loans showing stress.', to: '/m/predictive' },
  { app: 'campaigns', name: 'Campaign Summary (All Campaigns)', detail: 'Sends, applications and loan dollars by campaign.', to: '/m/campaigns' },
  { app: 'indirect', name: 'Dealership Scorecard', detail: 'Received, decisions and funded loans by dealer.', to: '/m/indirect' },
  { app: 'onboarding', name: 'Onboarding Performance', detail: 'Touch points due, late and missed.', to: '/m/onboarding' },
  { app: 'gi', name: 'All Goals Performance', detail: 'Attainment and payouts for the period.', to: '/m/gi' },
  { app: 'compliance', name: 'Complaints and Issues', detail: 'Open issues against their resolve-by dates.', to: '/m/compliance' },
];

export function OnDemandReports() {
  const { can } = useSession();
  const list = ON_DEMAND.filter((r) => can(r.app));
  return (
    <section aria-labelledby="od-title">
      <h2 id="od-title" className={styles.folderTitle}>
        On-Demand Reports
      </h2>
      <p className={styles.detail}>Run on last night’s build when you open them. Only the ones your access includes are listed.</p>
      {list.length ? (
        <ul className={styles.list}>
          {list.map((r) => (
            <li key={r.name}>
              <Link to={r.to} className={styles.item}>
                <FileBarChart size={18} aria-hidden className={styles.icon} />
                <span className={styles.text}>
                  <span className={styles.label}>{r.name}</span>
                  <span className={styles.detail}>{r.detail}</span>
                </span>
                <ChevronRight size={16} aria-hidden className={styles.icon} />
              </Link>
            </li>
          ))}
        </ul>
      ) : (
        <p className={styles.message}>None of the on-demand reports are part of your access.</p>
      )}
    </section>
  );
}
