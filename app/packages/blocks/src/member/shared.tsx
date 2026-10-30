// Pieces shared by the member card and the member 360: the person header, score meters and the
// actions they hand to the host (open the record, "Why?", refer, member declined).
import clsx from 'clsx';
import type { BlockAction, MemberCardBlock, MemberScore } from '@dinext/block-schemas';
import { Badge } from '@dinext/ui';
import styles from './Member.module.css';

export type MemberHeader = Pick<MemberCardBlock['data'], 'memberRef' | 'person' | 'displayName' | 'maskedNumber' | 'branch' | 'since' | 'badges'>;

export const initials = (name: string) =>
  name
    .split(/\s+/)
    .map((p) => p[0])
    .join('')
    .slice(0, 2)
    .toUpperCase();

const Person = (p: MemberHeader['person']) => (p === 'customer' ? 'Customer' : 'Member');
const firstName = (name: string) => name.split(/\s+/)[0] ?? name;

/** The actions a member block asks the host to run; each carries the record token, never a number. */
export const memberActions = {
  open: (m: MemberHeader): BlockAction => ({ id: 'open', kind: 'open_record', label: `Open ${Person(m.person)} 360`.slice(0, 40), params: { memberRef: m.memberRef, label: m.displayName } }),
  why: (m: MemberHeader, s: MemberScore): BlockAction => ({
    id: `why_${s.id}`,
    kind: 'explain',
    label: 'Why?',
    params: {
      memberRef: m.memberRef,
      label: m.displayName,
      question: s.id === 'attrition' ? `Why is ${firstName(m.displayName)}’s attrition risk ${s.band.toLowerCase()}?` : `Why is ${s.band} the next best product for ${firstName(m.displayName)}?`,
    },
  }),
  refer: (m: MemberHeader, product: string): BlockAction => ({ id: `refer_${product}`, kind: 'run_operation', label: 'Refer', operation: 'referral.create', riskTier: 'medium', params: { memberRef: m.memberRef, label: m.displayName, question: `Open a ${product} referral for ${m.displayName}` } }),
  declined: (m: MemberHeader, product: string): BlockAction => ({
    id: `declined_${product}`,
    kind: 'run_operation',
    label: `${Person(m.person)} declined`,
    operation: 'relationship.suggestion.decline',
    riskTier: 'low',
    params: { memberRef: m.memberRef, label: m.displayName, question: `${m.displayName} declined the ${product} offer` },
  }),
};

export function PersonHeader({ m, level = 3, children }: { m: MemberHeader; level?: 2 | 3; children?: React.ReactNode }) {
  const H = level === 2 ? 'h2' : 'h3';
  return (
    <div className={styles.person}>
      <span className={styles.avatar} aria-hidden>
        {initials(m.displayName)}
      </span>
      <div className={styles.who}>
        <H className={styles.name}>{m.displayName}</H>
        <p className={styles.ids}>
          {Person(m.person)} <span className="dn-num">{m.maskedNumber}</span> · {m.branch} · since {m.since}
        </p>
        {m.badges.length > 0 && (
          <ul className={styles.badges} aria-label="Status">
            {m.badges.map((b) => (
              <li key={b.label}>
                <Badge tone={b.tone}>{b.label}</Badge>
              </li>
            ))}
          </ul>
        )}
      </div>
      {children && <div className={styles.headerActions}>{children}</div>}
    </div>
  );
}

/** A 0-10 score as a labelled meter; the band is always written, so colour is never the only cue. */
export function ScoreMeter({ s, onWhy }: { s: MemberScore; onWhy?: () => void }) {
  return (
    <div className={styles.score}>
      <div className={styles.scoreTop}>
        <span className={styles.scoreLabel}>{s.label}</span>
        {onWhy && (
          <button type="button" className={styles.why} onClick={onWhy} aria-label={`Why? ${s.label}`}>
            Why?
          </button>
        )}
      </div>
      <div className={styles.scoreValue}>
        <strong>{s.band}</strong>
        <span className="dn-num">
          {s.value} / {s.scale}
        </span>
      </div>
      <div className={styles.meter} role="meter" aria-label={s.label} aria-valuemin={0} aria-valuemax={s.scale} aria-valuenow={s.value} aria-valuetext={`${s.band}, ${s.value} of ${s.scale}`}>
        <span className={clsx(styles.fill, styles[`fill_${s.tone}`])} style={{ width: `${(s.value / s.scale) * 100}%` }} />
      </div>
    </div>
  );
}
