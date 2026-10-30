// member_360 (spec 8.24, FE-RM-001): every section and widget of today's Relationship Dashboard
// [BK p11], as tabs that work with arrow keys. Opportunities carry "Refer" and "Member declined".
import { useId, useRef, useState, type KeyboardEvent } from 'react';
import clsx from 'clsx';
import { Check, Minus, Share2, ThumbsDown, TriangleAlert } from 'lucide-react';
import type { Member360Block, Member360Section } from '@dinext/block-schemas';
import { Badge, Button } from '@dinext/ui';
import { useBlockHost } from '../context.tsx';
import { formatValue } from '../format.ts';
import { memberActions, PersonHeader, ScoreMeter, type MemberHeader } from './shared.tsx';
import styles from './Member.module.css';

type Kind = Member360Section['kind'];

const LABELS: Record<Kind, string> = {
  overview: 'Overview',
  accounts: 'Accounts',
  digital: 'Digital',
  cross_sell: 'Cross-sell & growth',
  loan_apps: 'Loan apps',
  engagement: 'Engagement & retention',
  opportunities: 'Opportunities',
  interactions: 'Interactions',
  rewards: 'Rewards',
  contact: 'Contact',
  household: 'Household',
};

const dateOf = (iso: string) => new Intl.DateTimeFormat(undefined, { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' }).format(new Date(`${iso.slice(0, 10)}T00:00:00Z`));

export function Member360View({ block }: { block: Member360Block }) {
  const d = block.data;
  const host = useBlockHost();
  const base = useId();
  const [active, setActive] = useState<Kind>(d.sections[0]!.kind);
  const tabs = useRef<(HTMLButtonElement | null)[]>([]);
  const run = (a: ReturnType<typeof memberActions.open>) => host.onAction?.(block, a);

  // Roving focus for the tab list (WAI-ARIA tabs pattern, spec 10.7).
  const onKey = (e: KeyboardEvent, i: number) => {
    const n = d.sections.length;
    const next = e.key === 'ArrowRight' ? (i + 1) % n : e.key === 'ArrowLeft' ? (i - 1 + n) % n : e.key === 'Home' ? 0 : e.key === 'End' ? n - 1 : -1;
    if (next < 0) return;
    e.preventDefault();
    setActive(d.sections[next]!.kind);
    tabs.current[next]?.focus();
  };
  const counts: Partial<Record<Kind, number>> = {};
  for (const s of d.sections) {
    if (s.kind === 'opportunities') counts.opportunities = s.items.length;
    if (s.kind === 'interactions') counts.interactions = s.total;
    if (s.kind === 'loan_apps') counts.loan_apps = s.pending;
  }

  return (
    <div className={styles.record}>
      <PersonHeader m={d} level={2} />
      {d.alerts.length > 0 && (
        <ul className={styles.alerts} aria-label={`Alerts (${d.alerts.length})`}>
          {d.alerts.map((a) => (
            <li key={a.id}>
              <Badge tone={a.tone} icon={a.tone === 'danger' || a.tone === 'warning' ? <TriangleAlert size={12} aria-hidden /> : undefined}>
                {a.label}
              </Badge>
            </li>
          ))}
        </ul>
      )}
      <div role="tablist" aria-label={`${d.displayName} record sections`} className={styles.tabs}>
        {d.sections.map((s, i) => (
          <button
            key={s.kind}
            ref={(el) => {
              tabs.current[i] = el;
            }}
            type="button"
            role="tab"
            id={`${base}-tab-${s.kind}`}
            aria-selected={active === s.kind}
            aria-controls={`${base}-panel-${s.kind}`}
            tabIndex={active === s.kind ? 0 : -1}
            className={styles.tab}
            onClick={() => setActive(s.kind)}
            onKeyDown={(e) => onKey(e, i)}
          >
            {LABELS[s.kind]}
            {counts[s.kind] ? <span className={clsx(styles.tabCount, 'dn-num')}>{counts[s.kind]}</span> : null}
          </button>
        ))}
      </div>
      {d.sections
        .filter((s) => s.kind === active)
        .map((s) => (
          // A tab panel is focusable so a panel without buttons is still reachable (WAI-ARIA tabs pattern).
          // eslint-disable-next-line jsx-a11y/no-noninteractive-tabindex
          <div key={s.kind} role="tabpanel" id={`${base}-panel-${s.kind}`} aria-labelledby={`${base}-tab-${s.kind}`} tabIndex={0} className={styles.panel}>
            <Section s={s} m={d} run={run} />
          </div>
        ))}
    </div>
  );
}

function Section({ s, m, run }: { s: Member360Section; m: MemberHeader; run: (a: ReturnType<typeof memberActions.open>) => void }) {
  const person = m.person === 'customer' ? 'customer' : 'member';
  switch (s.kind) {
    case 'overview':
      return (
        <>
          <dl className={styles.figures}>
            {s.figures.map((f) => (
              <div key={f.label} className={styles.figure}>
                <dt>{f.label}</dt>
                <dd className="dn-num">{formatValue(f.value, f.unit)}</dd>
                {f.detail && <span className={styles.figureDetail}>{f.detail}</span>}
              </div>
            ))}
          </dl>
          <div className={styles.scores}>
            {s.scores.map((x) => (
              <ScoreMeter key={x.id} s={x} onWhy={() => run(memberActions.why(m, x))} />
            ))}
          </div>
          <Facts facts={s.facts} />
        </>
      );
    case 'accounts':
      return (
        <>
          <Accounts title="Deposit accounts" rows={s.deposits} empty="No open deposit accounts." />
          <Accounts title="Loan accounts" rows={s.loans} empty="No open loans." />
        </>
      );
    case 'digital':
      return (
        <ul className={styles.services}>
          {s.services.map((x) => (
            <li key={x.id} className={clsx(styles.service, x.enrolled && styles.enrolled)}>
              <span className={styles.serviceIcon}>{x.enrolled ? <Check size={14} aria-hidden /> : <Minus size={14} aria-hidden />}</span>
              <span>
                <span className={styles.serviceLabel}>{x.label}</span>
                <span className={styles.muted}>{x.enrolled ? (x.detail ?? 'Enrolled') : (x.detail ?? 'Not enrolled')}</span>
              </span>
            </li>
          ))}
        </ul>
      );
    case 'cross_sell':
      return (
        <>
          <table className={styles.table}>
            <caption className={styles.caption}>New products and services opened</caption>
            <thead>
              <tr>
                <th scope="col">Window</th>
                <th scope="col">Total</th>
                <th scope="col">Services</th>
                <th scope="col">Loan</th>
                <th scope="col">Deposit</th>
              </tr>
            </thead>
            <tbody>
              {s.windows.map((w) => (
                <tr key={w.days}>
                  <th scope="row">{w.days} days</th>
                  <td className="dn-num">{w.total}</td>
                  <td className="dn-num">{w.services}</td>
                  <td className="dn-num">{w.loan}</td>
                  <td className="dn-num">{w.deposit}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <div className={styles.split}>
            <div className={styles.figure}>
              <span className={styles.figureLabel}>Cross-sell</span>
              <strong className="dn-num">{s.crossSell}</strong>
              <span className={styles.figureDetail}>products held</span>
            </div>
            <ScoreMeter s={s.attrition} onWhy={() => run(memberActions.why(m, s.attrition))} />
          </div>
        </>
      );
    case 'loan_apps':
      return (
        <>
          <dl className={styles.figures}>
            {(['approved', 'denied', 'pending'] as const).map((k) => (
              <div key={k} className={styles.figure}>
                <dt>{k[0]!.toUpperCase() + k.slice(1)}</dt>
                <dd className="dn-num">{s[k]}</dd>
                <span className={styles.figureDetail}>last 365 days</span>
              </div>
            ))}
          </dl>
          {s.items.length > 0 && (
            <ul className={styles.rows}>
              {s.items.map((a, i) => (
                <li key={i} className={styles.rowItem}>
                  <span className={styles.rowMain}>
                    <span className={styles.rowTitle}>
                      {a.product} · <span className="dn-num">{formatValue(a.amount, 'currency')}</span>
                    </span>
                    <span className={styles.muted}>
                      Applied {dateOf(a.applied)} · {a.detail}
                    </span>
                  </span>
                  <Badge tone={a.status === 'Approved' ? 'success' : a.status === 'Denied' ? 'neutral' : 'info'}>{a.status}</Badge>
                </li>
              ))}
            </ul>
          )}
        </>
      );
    case 'engagement':
      return (
        <>
          <ScoreMeter s={s.attrition} onWhy={() => run(memberActions.why(m, s.attrition))} />
          {s.factors.length > 0 && (
            <ul className={styles.rows} aria-label="Score factors">
              {s.factors.map((f) => (
                <li key={f.label} className={styles.rowItem}>
                  <span className={styles.rowTitle}>{f.label}</span>
                  <span className={clsx(styles.weight, 'dn-num')}>{f.weight > 0 ? `raises by ${f.weight}` : `lowers by ${-f.weight}`}</span>
                </li>
              ))}
            </ul>
          )}
          <Facts facts={s.facts} />
        </>
      );
    case 'opportunities':
      return (
        <>
          {s.items.length === 0 ? (
            <p className={styles.empty}>No suggestions at {s.threshold} or above for this {person}.</p>
          ) : (
            <ul className={styles.rows}>
              {s.items.map((o) => (
                <li key={o.suggestionId} className={styles.opportunity}>
                  <span className={styles.rowMain}>
                    <span className={styles.rowTitle}>
                      {o.product} <span className={clsx(styles.likelihood, 'dn-num')}>{o.likelihood}/10</span>
                    </span>
                    <span className={styles.muted}>{o.reason}</span>
                  </span>
                  <span className={styles.oppActions}>
                    {o.referralTypeId && (
                      <Button size="sm" icon={<Share2 size={14} aria-hidden />} onClick={() => run(memberActions.refer(m, o.product))} aria-label={`Refer ${m.displayName} for ${o.product}`}>
                        Refer
                      </Button>
                    )}
                    <Button size="sm" variant="ghost" icon={<ThumbsDown size={14} aria-hidden />} onClick={() => run(memberActions.declined(m, o.product))} aria-label={`${m.displayName} declined ${o.product}`}>
                      {person === 'customer' ? 'Customer' : 'Member'} declined
                    </Button>
                  </span>
                </li>
              ))}
            </ul>
          )}
          {s.declined.length > 0 && (
            <p className={styles.muted}>
              Hidden after a decline: {s.declined.map((x) => `${x.product} (until ${dateOf(x.until)}, by ${x.by})`).join('; ')}.
            </p>
          )}
        </>
      );
    case 'interactions':
      return (
        <>
          <p className={styles.muted}>
            {s.total} in the last 12 months{s.items.length < s.total ? `, newest ${s.items.length} shown` : ''}.
          </p>
          <ol className={styles.timeline}>
            {s.items.map((x, i) => (
              <li key={i} className={styles.event}>
                <time className={clsx(styles.when, 'dn-num')} dateTime={x.at}>
                  {dateOf(x.at)}
                </time>
                <span className={styles.rowMain}>
                  <span className={styles.rowTitle}>{x.summary}</span>
                  <span className={styles.muted}>
                    {x.kind} · {x.channel}
                    {x.by ? ` · ${x.by}` : ''}
                  </span>
                </span>
              </li>
            ))}
          </ol>
        </>
      );
    case 'rewards':
      return <p className={styles.empty}>{s.detail ?? (s.status === 'not_enrolled' ? `This ${person} is not enrolled in rewards.` : 'Rewards are not set up.')}</p>;
    case 'contact':
      return (
        <Facts
          facts={[
            { label: 'Preferred', value: s.preferred },
            { label: 'Email', value: s.email },
            { label: 'Phone', value: s.phone },
          ]}
        />
      );
    case 'household': {
      const shown = s.members.filter((h) => h.inPurview);
      const hidden = s.members.length - shown.length;
      if (!s.members.length) return <p className={styles.empty}>No one else in the household.</p>;
      return (
        <ul className={styles.rows}>
          {shown.map((h, i) => (
            <li key={i} className={styles.rowItem}>
              <span className={styles.rowMain}>
                <span className={styles.rowTitle}>{h.name}</span>
                <span className={styles.muted}>
                  {h.branch} · <span className="dn-num">{h.maskedNumber}</span>
                </span>
              </span>
            </li>
          ))}
          {hidden > 0 && (
            <li className={styles.rowItem}>
              <span className={styles.muted}>
                {hidden} more {hidden === 1 ? 'person' : 'people'} outside your branches, not shown.
              </span>
            </li>
          )}
        </ul>
      );
    }
  }
}

function Facts({ facts }: { facts: { label: string; value: string }[] }) {
  if (!facts.length) return null;
  return (
    <dl className={styles.facts}>
      {facts.map((f) => (
        <div key={f.label}>
          <dt>{f.label}</dt>
          <dd>{f.value}</dd>
        </div>
      ))}
    </dl>
  );
}

type Row = Extract<Member360Section, { kind: 'accounts' }>['deposits'][number];

function Accounts({ title, rows, empty }: { title: string; rows: Row[]; empty: string }) {
  return (
    <table className={styles.table}>
      <caption className={styles.caption}>{title}</caption>
      {rows.length === 0 ? (
        <tbody>
          <tr>
            <td className={styles.empty}>{empty}</td>
          </tr>
        </tbody>
      ) : (
        <>
          <thead>
            <tr>
              <th scope="col">Account</th>
              <th scope="col">Relationship</th>
              <th scope="col" className={styles.num}>
                Balance
              </th>
              <th scope="col" className={styles.num}>
                30-day change
              </th>
              <th scope="col" className={styles.num}>
                Fees, 30 days
              </th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={`${r.name}${r.suffix}`}>
                <th scope="row">
                  {r.name} <span className={clsx(styles.muted, 'dn-num')}>…{r.suffix}</span>
                  {r.detail && <span className={styles.rowDetail}>{r.detail}</span>}
                </th>
                <td>{r.relationship}</td>
                <td className={clsx(styles.num, 'dn-num')}>{formatValue(r.balance, 'currency', { decimals: 2 })}</td>
                <td className={clsx(styles.num, 'dn-num', r.change30d < 0 ? styles.down : r.change30d > 0 ? styles.up : undefined)}>{formatValue(r.change30d, 'currency', { signed: true })}</td>
                <td className={clsx(styles.num, 'dn-num')}>{r.fees30d ? formatValue(r.fees30d, 'currency') : '—'}</td>
              </tr>
            ))}
          </tbody>
        </>
      )}
    </table>
  );
}
