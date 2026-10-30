import clsx from 'clsx';
import styles from './Skeleton.module.css';

export interface SkeletonProps {
  width?: string;
  height?: string;
  radius?: 'sm' | 'md' | 'full';
  className?: string;
}

/** Decorative placeholder. The owning block carries aria-busy and the status text. */
export function Skeleton({ width = '100%', height = '1em', radius = 'sm', className }: SkeletonProps) {
  return <span aria-hidden className={clsx(styles.skeleton, styles[radius], className)} style={{ width, height }} />;
}
