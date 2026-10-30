// The single place where a person authorises a write (spec 6.10, 9.7, 12.5).
// Confirmation controls are rendered exactly as declared and never weaker than the tier (FE-GEN-030).
import { useEffect, useId, useRef, useState, type KeyboardEvent, type MouseEvent } from 'react';
import clsx from 'clsx';
import { CheckCircle2, Clock, CornerUpLeft, KeyRound, Mic, MicOff, Pencil, ShieldCheck, UserCheck, XCircle } from 'lucide-react';
import type { ApprovalCardBlock, ApprovalDecisionRequest, ApprovalPreview } from '@dinext/block-schemas';
import { Button, RiskBadge, TextInput, useAnnouncer } from '@dinext/ui';
import { useBlockHost } from '../context.tsx';
import { formatClock, formatRelativeFuture, formatValue } from '../format.ts';
import styles from './ApprovalCardView.module.css';

type Decision = ApprovalDecisionRequest['decision'];
type Channel = ApprovalDecisionRequest['channel'];

const normalise = (s: string) => s.trim().replace(/\s+/g, ' ').toLowerCase();

function useExpiry(expiresAt: string, now: () => number) {
  const [current, setCurrent] = useState(now);
  useEffect(() => {
    const t = setInterval(() => setCurrent(now()), 15_000);
    return () => clearInterval(t);
  }, [now]);
  return { expired: new Date(expiresAt).getTime() <= current, label: formatRelativeFuture(expiresAt, current) };
}

export function ApprovalCardView({ block }: { block: ApprovalCardBlock }) {
  const host = useBlockHost();
  const { announce } = useAnnouncer();
  const d = block.data;
  const now = host.now ?? Date.now;
  const { expired, label: expiresLabel } = useExpiry(d.expiresAt, now);
  const headingId = useId();
  const noteId = useId();

  const [typed, setTyped] = useState('');
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState<Decision | null>(null);
  const [error, setError] = useState<{ field?: 'typed' | 'note'; message: string } | null>(null);
  const [needsNote, setNeedsNote] = useState(false);
  const announced = useRef(false);
  const noteRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    if (needsNote && !d.confirmation.noteRequired) noteRef.current?.focus();
  }, [needsNote, d.confirmation.noteRequired]);

  // Approval cards announce once, assertively, when they appear (spec 10.8).
  useEffect(() => {
    // Home lists waiting approvals rather than raising new ones, so only conversation cards announce.
    if (announced.current || d.resolution || host.approvalDisplay === 'summary') return;
    announced.current = true;
    announce(`Approval needed, ${d.riskTier} risk: ${d.summary}`, 'assertive');
  }, [announce, d.resolution, d.riskTier, d.summary, host.approvalDisplay]);

  const [reviewing, setReviewing] = useState(host.approvalDisplay !== 'summary');
  const summaryRef = useRef<HTMLHeadingElement>(null);
  useEffect(() => {
    if (reviewing && host.approvalDisplay === 'summary') summaryRef.current?.focus();
  }, [reviewing, host.approvalDisplay]);

  const typedOk = !d.confirmation.typedValue || normalise(typed) === normalise(d.confirmation.typedValue.expected);
  const noteOk = !d.confirmation.noteRequired || note.trim().length > 0;
  const resolved = d.resolution;
  const locked = Boolean(resolved) || expired;
  const voice = d.confirmation.methods.includes('voice') && d.riskTier !== 'high' && (d.riskTier === 'low' || host.voiceMediumAllowed !== false);

  const submit = async (decision: Decision, channel: Channel, stepUpToken: string | null = null): Promise<void> => {
    if (!host.onDecision || busy || locked) return;
    if (decision === 'approve' && !typedOk) {
      setError({ field: 'typed', message: `Type ${d.confirmation.typedValue?.expected} exactly to approve.` });
      return;
    }
    if ((decision === 'approve' && !noteOk) || (decision === 'return' && !note.trim())) {
      setNeedsNote(true);
      setError({ field: 'note', message: decision === 'return' ? 'Add a note so the requester knows what to change.' : 'A note is required for this approval.' });
      return;
    }
    setError(null);
    setBusy(decision);
    const result = await host.onDecision(
      block,
      {
        decision,
        channel,
        typedConfirmation: d.confirmation.typedValue ? typed.trim() : null,
        note: note.trim() || null,
        editedPlan: null,
        stepUpToken,
        clientContext: { blockVersionSeen: block.version, previewHash: d.previewHash },
      },
      d.idempotencyKey,
    );
    setBusy(null);
    if (result.ok) {
      announce(`${result.decision === 'approved' ? 'Approved' : result.decision === 'denied' ? 'Denied' : 'Returned'}: ${d.summary}`);
      return;
    }
    switch (result.code) {
      case 'STEP_UP_REQUIRED': {
        const token = await host.onStepUp?.();
        if (token) return submit(decision, channel, token);
        setError({ message: 'Re-authentication is needed before this change can be approved.' });
        return;
      }
      case 'CONFIRMATION_MISMATCH':
        setError({ field: 'typed', message: result.message ?? 'The typed value does not match.' });
        return;
      case 'PREVIEW_CHANGED':
        setError({ message: 'The pending change was updated after you opened it. Review the new preview before deciding.' });
        return;
      case 'ALREADY_DECIDED':
        setError({ message: 'Someone has already decided on this request.' });
        return;
      case 'EXPIRED':
        setError({ message: 'This request has expired. Ask again to get a fresh approval.' });
        return;
    }
  };

  /** A click with detail 0 came from Enter or Space, so the audit channel is "keyboard". */
  const channelOf = (e: MouseEvent) => (e.detail === 0 ? 'keyboard' : 'click');

  const onKeyDown = (e: KeyboardEvent) => {
    if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') {
      e.preventDefault();
      void submit('approve', 'keyboard');
    }
  };

  return (
    // eslint-disable-next-line jsx-a11y/no-noninteractive-element-interactions -- Ctrl/Cmd+Enter approves from any field in the card
    <section className={clsx(styles.card, styles[d.riskTier], locked && styles.locked)} aria-labelledby={headingId} onKeyDown={onKeyDown}>
      <header className={styles.band}>
        <span className={styles.eyebrow}>{resolved ? 'Decision recorded' : expired ? 'Approval expired' : 'Approval needed'}</span>
        <RiskBadge tier={d.riskTier} />
      </header>

      <div className={styles.main}>
        <h3 id={headingId} ref={summaryRef} tabIndex={-1} className={styles.summary}>
          {d.summary}
        </h3>
        <p className={styles.requested}>
          {d.requestedBy.kind === 'agent_run' ? (
            <>
              Requested by <strong>{d.requestedBy.agent ?? 'an agent'}</strong> (run {d.requestedBy.runId})
              {d.requestedBy.onBehalfOfName && <>, on behalf of {d.requestedBy.onBehalfOfName}</>}
            </>
          ) : (
            <>
              Submitted by <strong>{d.requestedBy.onBehalfOfName ?? 'you'}</strong>
            </>
          )}
        </p>

        {!reviewing && !resolved ? (
          <div className={styles.compact}>
            <Affected affected={d.affected} />
            <div className={styles.actions}>
              <Button variant="primary" onClick={() => setReviewing(true)} disabled={expired} aria-expanded={false}>
                Review
              </Button>
              <span className={styles.meta}>
                <span className={clsx(styles.expiry, expired && styles.expiredText)}>
                  <Clock size={14} aria-hidden />
                  {expired ? 'Expired. Ask again' : `Expires ${expiresLabel}`}
                </span>
              </span>
            </div>
          </div>
        ) : (
          <div className={styles.section}>
            <h4 className={styles.sectionTitle}>What will change</h4>
            <Preview preview={d.preview} />
            <Affected affected={d.affected} />
          </div>
        )}

        {!reviewing && !resolved ? null : resolved ? (
          <Resolution resolution={resolved} />
        ) : (
          <div className={styles.section}>
            {(d.confirmation.secondApprover || d.confirmation.stepUp) && (
              <ul className={styles.requirements}>
                {d.confirmation.secondApprover && (
                  <li>
                    <UserCheck size={16} aria-hidden />
                    Second approver required: <strong>{d.confirmation.secondApprover.role}</strong>
                    {d.confirmation.secondApprover.policy && <> (policy {d.confirmation.secondApprover.policy})</>}
                  </li>
                )}
                {d.confirmation.stepUp && (
                  <li>
                    <KeyRound size={16} aria-hidden />
                    You will be asked to sign in again before this is approved.
                  </li>
                )}
              </ul>
            )}

            {d.confirmation.typedValue && (
              <TextInput
                label={d.confirmation.typedValue.prompt}
                hint={
                  <>
                    Type <strong className="dn-num">{d.confirmation.typedValue.expected}</strong> to confirm.
                  </>
                }
                value={typed}
                onChange={(e) => {
                  setTyped(e.target.value);
                  if (error?.field === 'typed') setError(null);
                }}
                disabled={locked}
                autoComplete="off"
                spellCheck={false}
                error={error?.field === 'typed' ? error.message : undefined}
                className={styles.typed}
              />
            )}

            {(d.confirmation.noteRequired || needsNote) && (
              <div className={styles.noteField}>
                <label htmlFor={noteId} className={styles.noteLabel}>
                  Note{d.confirmation.noteRequired && <span aria-hidden> *</span>}
                  {d.confirmation.noteRequired && <span className="dn-visually-hidden"> (required)</span>}
                </label>
                <textarea
                  ref={noteRef}
                  id={noteId}
                  className={clsx(styles.note, error?.field === 'note' && styles.invalid)}
                  rows={2}
                  value={note}
                  maxLength={1000}
                  disabled={locked}
                  aria-invalid={error?.field === 'note' || undefined}
                  aria-describedby={error?.field === 'note' ? `${noteId}-err` : undefined}
                  onChange={(e) => {
                    setNote(e.target.value);
                    if (error?.field === 'note') setError(null);
                  }}
                />
                {error?.field === 'note' && (
                  <span id={`${noteId}-err`} className={styles.fieldError}>
                    {error.message}
                  </span>
                )}
              </div>
            )}

            {error && !error.field && (
              <p className={styles.error} role="alert">
                {error.message}
              </p>
            )}

            <div className={styles.actions}>
              <Button
                variant="primary"
                icon={<CheckCircle2 size={16} aria-hidden />}
                busy={busy === 'approve'}
                disabled={locked || (busy !== null && busy !== 'approve')}
                onClick={(e) => void submit('approve', channelOf(e))}
                aria-keyshortcuts="Control+Enter Meta+Enter"
              >
                Approve
              </Button>
              <Button
                icon={<CornerUpLeft size={16} aria-hidden />}
                busy={busy === 'return'}
                disabled={locked || (busy !== null && busy !== 'return')}
                onClick={(e) => {
                  // First press reveals the note field; returning always needs a note (spec 12.5).
                  if (!needsNote && !d.confirmation.noteRequired) {
                    setNeedsNote(true);
                    return;
                  }
                  void submit('return', channelOf(e));
                }}
              >
                Return with note
              </Button>
              <Button
                variant="ghost"
                icon={<XCircle size={16} aria-hidden />}
                busy={busy === 'deny'}
                disabled={locked || (busy !== null && busy !== 'deny')}
                onClick={(e) => void submit('deny', channelOf(e))}
              >
                Deny
              </Button>
              {d.editablePlan && (
                <Button variant="ghost" icon={<Pencil size={16} aria-hidden />} disabled={locked || busy !== null} onClick={(e) => void submit('edit', channelOf(e))}>
                  Edit plan
                </Button>
              )}
              <span className={styles.meta}>
                <span className={styles.voice}>
                  {voice ? <Mic size={14} aria-hidden /> : <MicOff size={14} aria-hidden />}
                  {voice ? (d.riskTier === 'medium' ? 'Voice: after read-back' : 'Voice: allowed') : 'Voice: not allowed'}
                </span>
                <span className={clsx(styles.expiry, expired && styles.expiredText)}>
                  <Clock size={14} aria-hidden />
                  {expired ? 'Expired. Ask again' : `Expires ${expiresLabel}`}
                </span>
              </span>
            </div>
          </div>
        )}
      </div>
    </section>
  );
}

function Preview({ preview }: { preview: ApprovalPreview }) {
  switch (preview.kind) {
    case 'record':
      return (
        <dl className={styles.fields}>
          {preview.fields.map((f) => (
            <div key={f.label} className={styles.fieldRow}>
              <dt>{f.label}</dt>
              <dd>{f.value}</dd>
            </div>
          ))}
        </dl>
      );
    case 'diff':
      return (
        <table className={styles.diff}>
          <thead>
            <tr>
              <th scope="col">Field</th>
              <th scope="col">Before</th>
              <th scope="col">After</th>
            </tr>
          </thead>
          <tbody>
            {preview.changes.map((c) => (
              <tr key={c.label}>
                <th scope="row">{c.label}</th>
                <td>
                  <del>{c.before}</del>
                </td>
                <td>
                  <ins>{c.after}</ins>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      );
    case 'bulk':
      return (
        <div className={styles.bulk}>
          <p>{preview.description}</p>
          {preview.totals && (
            <p className={styles.totals}>
              {preview.totals.map((t) => (
                <span key={t.label}>
                  {t.label} <strong className="dn-num">{t.value}</strong>
                </span>
              ))}
            </p>
          )}
          <table className={styles.sample}>
            <caption className="dn-visually-hidden">
              Sample of {preview.sample.length} of {preview.count} records
            </caption>
            <thead>
              <tr>
                {preview.columns.map((c) => (
                  <th key={c.field} scope="col" className={c.type !== 'text' ? styles.num : undefined}>
                    {c.headerName}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {preview.sample.map((row, i) => (
                <tr key={i}>
                  {preview.columns.map((c) => {
                    const v = row[c.field];
                    return (
                      <td key={c.field} className={c.type !== 'text' ? clsx(styles.num, 'dn-num') : undefined}>
                        {typeof v === 'number' && c.type !== 'text' ? formatValue(v, c.type, { decimals: c.type === 'currency' ? 2 : undefined, compact: false }) : String(v ?? '—')}
                      </td>
                    );
                  })}
                </tr>
              ))}
            </tbody>
          </table>
          {preview.count > preview.sample.length && <p className={styles.more}>… and {preview.count - preview.sample.length} more</p>}
        </div>
      );
    case 'message':
      return (
        <div className={styles.message}>
          <p className={styles.messageMeta}>
            To <strong>{preview.to.join(', ')}</strong>
          </p>
          {preview.subject && <p className={styles.messageSubject}>{preview.subject}</p>}
          <p className={styles.messageBody}>{preview.body}</p>
        </div>
      );
  }
}

function Affected({ affected }: { affected: ApprovalCardBlock['data']['affected'] }) {
  const parts = [
    `${affected.records} ${affected.records === 1 ? 'record' : 'records'}`,
    affected.users ? `${affected.users} ${affected.users === 1 ? 'person' : 'people'} notified` : null,
    affected.external ? `${affected.external} external` : 'nothing leaves DI',
  ].filter(Boolean);
  return <p className={styles.affected}>{parts.join(' · ')}</p>;
}

function Resolution({ resolution }: { resolution: NonNullable<ApprovalCardBlock['data']['resolution']> }) {
  const approved = resolution.decision === 'approved';
  const word = { approved: 'Approved', denied: 'Denied', returned: 'Returned', expired: 'Expired' }[resolution.decision];
  return (
    <p className={clsx(styles.resolution, approved ? styles.resolvedOk : styles.resolvedOther)} role="status">
      {approved ? <ShieldCheck size={16} aria-hidden /> : <XCircle size={16} aria-hidden />}
      <span>
        <strong>{word}</strong> by {resolution.by} at {formatClock(resolution.at)}
        {resolution.channel && <> ({resolution.channel})</>}
        {resolution.note && <> · “{resolution.note}”</>}
      </span>
    </p>
  );
}
