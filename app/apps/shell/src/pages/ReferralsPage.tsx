// Referrals inbox (spec 17.3, FE-REF-001, FE-WF-001): work assigned to you, your team's work and what
// you sent, with the stage bar, history and actions for one referral beside the list. Clicking here
// is the person's own action; anything DI proposes in a conversation comes as an approval card.
import { useEffect, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import clsx from 'clsx';
import { Check, CircleAlert, Inbox, Landmark, MessageSquarePlus, Play, Send, Sparkles, UserRound, Users, X } from 'lucide-react';
import { Button, SegmentedControl, Skeleton, TextInput, useAnnouncer, useToast } from '@dinext/ui';
import type { ContextRef, ReferralAction, ReferralDetail, ReferralStageName, ReferralSummary } from '@dinext/block-schemas';
import { ApiError } from '@dinext/stream-client';
import { useSession } from '../session/SessionProvider.tsx';
import { useUi } from '../shell/uiStore.ts';
import page from './Page.module.css';
import styles from './ReferralsPage.module.css';

type Box = 'mine' | 'team' | 'sent';

const STAGES: ReferralStageName[] = ['New Referral', 'Active', 'Sold', 'Not Interested', 'Done'];
const age = (days: number) => (days === 0 ? 'Today' : days === 1 ? '1 day old' : `${days} days old`);
const when = (iso: string) => new Intl.DateTimeFormat(undefined, { day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' }).format(new Date(iso));
const due = (iso: string) => new Intl.DateTimeFormat(undefined, { day: 'numeric', month: 'short' }).format(new Date(iso));
const isOpen = (stage: ReferralStageName) => stage === 'New Referral' || stage === 'Active';

export function ReferralsPage() {
  const { api, terms } = useSession();
  const [params, setParams] = useSearchParams();
  const selected = Number(params.get('id')) || null;
  const [box, setBox] = useState<Box | null>(null);
  const q = useQuery({ queryKey: ['referrals', box ?? 'mine'], queryFn: () => api.referrals(box ?? 'mine'), refetchInterval: 15_000 });
  // Someone with no queue of their own starts on their team.
  const active: Box = box ?? (q.data && !q.data.hasOwnQueue ? 'team' : 'mine');
  const list = useQuery({ queryKey: ['referrals', active], queryFn: () => api.referrals(active), enabled: active !== (box ?? 'mine'), refetchInterval: 15_000 });
  const data = active === (box ?? 'mine') ? q.data : list.data;
  const open = (id: number | null) => setParams(id ? { id: String(id) } : {});

  useEffect(() => {
    useUi.getState().visit({ kind: 'view', path: '/workflows/referrals/inbox', label: 'Referrals' });
  }, []);

  return (
    <div className={clsx(page.page, styles.page)}>
      <header className={page.header}>
        <h1 className={page.title}>Referrals</h1>
        <p className={page.lede}>{data ? (data.counts.overdue ? `${data.counts.overdue} overdue. Oldest first, so nothing waits too long.` : 'Nothing overdue.') : `Work on your ${terms.person}s’ referrals, or ask DI what’s on your plate.`}</p>
        <SegmentedControl
          label="Referrals view"
          value={active}
          onChange={(v) => {
            setBox(v);
            open(null);
          }}
          options={[
            ...(q.data?.hasOwnQueue === false ? [] : [{ value: 'mine' as const, label: `Mine${data ? ` (${data.counts.mine})` : ''}`, icon: <Inbox size={14} aria-hidden /> }]),
            { value: 'team' as const, label: `Team${data ? ` (${data.counts.team})` : ''}`, icon: <Users size={14} aria-hidden /> },
            { value: 'sent' as const, label: 'Sent', icon: <Send size={14} aria-hidden /> },
          ]}
        />
      </header>

      {q.isPending && <Skeleton height="240px" radius="md" />}
      {q.isError && (
        <p className={styles.message} role="alert">
          {q.error instanceof ApiError && q.error.status === 404 ? 'Referrals are not loaded in this environment. Run npm run db:seed, then restart the server.' : 'Referrals could not be loaded. Try again in a moment.'}
        </p>
      )}

      {data && (
        <div className={clsx(styles.columns, selected && styles.withDetail)}>
          {data.items.length === 0 ? (
            <p className={styles.message}>{active === 'sent' ? 'You haven’t sent any referrals yet.' : active === 'mine' ? 'Nothing is waiting for you.' : 'Nothing is open for your team.'}</p>
          ) : (
            <ul className={styles.list} aria-label="Referrals">
              {data.items.map((r) => (
                <li key={r.comId}>
                  <Row item={r} showAssignee={active !== 'mine'} selected={r.comId === selected} onOpen={() => open(r.comId)} />
                </li>
              ))}
            </ul>
          )}
          {selected && <Detail id={selected} onClose={() => open(null)} />}
        </div>
      )}
    </div>
  );
}

function Row({ item, showAssignee, selected, onOpen }: { item: ReferralSummary; showAssignee: boolean; selected: boolean; onOpen: () => void }) {
  return (
    <button type="button" className={clsx(styles.row, selected && styles.rowSelected)} aria-current={selected || undefined} onClick={onOpen}>
      <span className={styles.rowMain}>
        <span className={styles.rowTitle}>{item.name}</span>
        <span className={styles.rowSub}>
          {item.typeLabel} · {item.branch}
          {showAssignee && ` · ${item.assignee?.name ?? 'Not claimed'}`}
        </span>
      </span>
      <span className={styles.rowSide}>
        {item.overdue ? (
          <span className={styles.overdue}>
            <CircleAlert size={12} aria-hidden />
            Overdue
          </span>
        ) : (
          <span className={styles.stage}>{item.stage}</span>
        )}
        <span className={styles.rowSub}>{age(item.ageDays)}</span>
      </span>
    </button>
  );
}

function Detail({ id, onClose }: { id: number; onClose: () => void }) {
  const { api, startThread, terms } = useSession();
  const navigate = useNavigate();
  const toast = useToast();
  const { announce } = useAnnouncer();
  const queryClient = useQueryClient();
  const [note, setNote] = useState('');
  const [closing, setClosing] = useState<'Sold' | 'Not Interested' | 'Done' | null>(null);
  const q = useQuery({ queryKey: ['referral', id], queryFn: () => api.referral(id) });
  const act = useMutation({
    mutationFn: (action: ReferralAction) => api.referralAction(id, action),
    onSuccess: (detail) => {
      queryClient.setQueryData(['referral', id], detail);
      void queryClient.invalidateQueries({ queryKey: ['referrals'] });
      setNote('');
      setClosing(null);
      announce(`Referral ${id} updated. Stage: ${detail.stage}.`);
    },
    onError: (err) => toast.show(err instanceof ApiError ? err.message : 'That didn’t go through. Try again.'),
  });

  if (q.isPending) return <Skeleton height="320px" radius="md" />;
  if (!q.data) {
    return (
      <section className={styles.detail}>
        <p className={styles.message}>This referral isn’t available. It may be outside your access.</p>
      </section>
    );
  }
  const r: ReferralDetail = q.data;
  const chip: ContextRef = { type: 'member', ref: r.memberRef, label: r.name };
  const canAct = r.canWork && isOpen(r.stage);
  const contact = r.fields.preferred_contact;
  // A follow-up task for staff closes as Done; it is not a sale.
  const task = r.category === 'Task';
  const closes = task ? ['Done'] : r.stage === 'Not Interested' ? ['Not Interested'] : ['Sold'];

  return (
    <section className={styles.detail} aria-labelledby="referral-title">
      <header className={styles.detailHead}>
        <div>
          <h2 id="referral-title" className={styles.detailTitle}>
            {r.name}
          </h2>
          <p className={styles.rowSub}>
            {r.typeLabel} · #{r.comId} · …{r.last4}
          </p>
        </div>
        <button type="button" className={styles.close} aria-label="Close referral" onClick={onClose}>
          <X size={16} aria-hidden />
        </button>
      </header>

      <ol className={styles.stages} aria-label="Stage">
        {STAGES.filter((s) => s === 'New Referral' || s === 'Active' || closes.includes(s)).map((s) => (
          <li key={s} className={clsx(styles.stageStep, s === r.stage && styles.stageNow)} aria-current={s === r.stage ? 'step' : undefined}>
            {s}
          </li>
        ))}
      </ol>

      <dl className={styles.facts}>
        <div>
          <dt>Assigned to</dt>
          <dd>{r.assignee?.name ?? 'Not claimed'}</dd>
        </div>
        <div>
          <dt>{r.overdue ? 'Was due' : 'Due'}</dt>
          <dd className={clsx(r.overdue && styles.overdue)}>{due(r.dueAt)}</dd>
        </div>
        <div>
          <dt>Priority</dt>
          <dd>{r.priority}</dd>
        </div>
        {contact !== undefined && (
          <div>
            <dt>Prefers</dt>
            <dd>{String(contact)}</dd>
          </div>
        )}
      </dl>
      {r.notes && <p className={styles.note}>{r.notes}</p>}

      <div className={styles.actions}>
        <Button icon={<UserRound size={14} aria-hidden />} onClick={() => useUi.getState().openWorkspace({ kind: 'member', ref: r.memberRef, label: r.name })}>
          Open {terms.person}
        </Button>
        <Button icon={<Sparkles size={14} aria-hidden />} onClick={() => void startThread(`Prepare me for my meeting with ${r.name}`, [chip]).then((t) => navigate(`/c/${t}`))}>
          Prepare me
        </Button>
        {r.fields.application_id !== undefined && (
          <Button icon={<Landmark size={14} aria-hidden />} onClick={() => navigate(`/m/lap?id=${r.fields.application_id}`)}>
            Open application
          </Button>
        )}
      </div>

      {canAct && (
        <div className={styles.work}>
          {closing ? (
            <div className={styles.confirm} role="group" aria-label={`Confirm ${closing}`}>
              <p>{closing === 'Sold' ? 'Mark this Sold? It can drive incentive credit.' : closing === 'Done' ? 'Mark this task done?' : 'Mark this Not Interested?'} This closes it.</p>
              <div className={styles.actions}>
                <Button variant="primary" icon={<Check size={14} aria-hidden />} disabled={act.isPending} onClick={() => act.mutate({ kind: 'close', stage: closing, note: note.trim() || undefined })}>
                  Confirm
                </Button>
                <Button variant="ghost" onClick={() => setClosing(null)}>
                  Cancel
                </Button>
              </div>
            </div>
          ) : (
            <div className={styles.actions}>
              {r.stage === 'New Referral' && (
                <Button variant="primary" icon={<Play size={14} aria-hidden />} disabled={act.isPending} onClick={() => act.mutate({ kind: 'start' })}>
                  Start working
                </Button>
              )}
              {task ? (
                <Button disabled={act.isPending} onClick={() => setClosing('Done')}>
                  Mark done
                </Button>
              ) : (
                <>
                  <Button disabled={act.isPending} onClick={() => setClosing('Sold')}>
                    Sold
                  </Button>
                  <Button variant="ghost" disabled={act.isPending} onClick={() => setClosing('Not Interested')}>
                    Not interested
                  </Button>
                </>
              )}
            </div>
          )}
          <form
            className={styles.noteForm}
            onSubmit={(e) => {
              e.preventDefault();
              if (note.trim() && !closing) act.mutate({ kind: 'note', text: note.trim() });
            }}
          >
            <TextInput label="Add a note" hideLabel placeholder="Add a note, such as “left voicemail”" value={note} onChange={(e) => setNote(e.target.value)} />
            <Button type="submit" icon={<MessageSquarePlus size={14} aria-hidden />} disabled={!note.trim() || Boolean(closing) || act.isPending}>
              Add
            </Button>
          </form>
          {r.team.length > 1 && (
            <label className={styles.assign}>
              <span>Assign to</span>
              <select value={r.assignee?.employeeId ?? ''} disabled={act.isPending} onChange={(e) => act.mutate({ kind: 'assign', employeeId: Number(e.target.value) })}>
                {!r.assignee && <option value="">Not claimed</option>}
                {r.team.map((m) => (
                  <option key={m.employeeId} value={m.employeeId}>
                    {m.name}
                  </option>
                ))}
              </select>
            </label>
          )}
        </div>
      )}

      <section aria-labelledby="referral-history">
        <h3 id="referral-history" className={styles.historyTitle}>
          History
        </h3>
        {r.history.length === 0 ? (
          <p className={styles.rowSub}>Sent by {r.senderName}.</p>
        ) : (
          <ol className={styles.history}>
            {r.history.map((h, i) => (
              <li key={i}>
                <span>{h.text}</span>
                <span className={styles.rowSub}>{when(h.at)}</span>
              </li>
            ))}
          </ol>
        )}
      </section>
    </section>
  );
}
