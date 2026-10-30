import type { ReactNode } from 'react';
import clsx from 'clsx';
import { CircleAlert, CircleCheck, Eye, Info, ShieldAlert, TriangleAlert } from 'lucide-react';
import styles from './Badge.module.css';

export type BadgeTone = 'neutral' | 'accent' | 'info' | 'success' | 'warning' | 'danger';

export interface BadgeProps {
  tone?: BadgeTone;
  icon?: ReactNode;
  children: ReactNode;
  variant?: 'subtle' | 'outline';
}

export function Badge({ tone = 'neutral', icon, children, variant = 'subtle' }: BadgeProps) {
  return (
    <span className={clsx(styles.badge, styles[tone], styles[variant])}>
      {icon}
      {children}
    </span>
  );
}

export type RiskTier = 'read' | 'low' | 'medium' | 'high';

const riskMeta: Record<RiskTier, { tone: BadgeTone; label: string; icon: ReactNode }> = {
  read: { tone: 'neutral', label: 'Read only', icon: <Eye size={12} aria-hidden /> },
  low: { tone: 'info', label: 'Low risk', icon: <Info size={12} aria-hidden /> },
  medium: { tone: 'warning', label: 'Medium risk', icon: <TriangleAlert size={12} aria-hidden /> },
  high: { tone: 'danger', label: 'High risk', icon: <ShieldAlert size={12} aria-hidden /> },
};

/** Risk tier is always icon + text + colour, so colour is never the only cue (spec 10.2). */
export function RiskBadge({ tier }: { tier: RiskTier }) {
  const meta = riskMeta[tier];
  return (
    <Badge tone={meta.tone} icon={meta.icon}>
      {meta.label}
    </Badge>
  );
}

export const statusIcons = {
  success: <CircleCheck size={16} aria-hidden />,
  warning: <TriangleAlert size={16} aria-hidden />,
  danger: <CircleAlert size={16} aria-hidden />,
  info: <Info size={16} aria-hidden />,
};
