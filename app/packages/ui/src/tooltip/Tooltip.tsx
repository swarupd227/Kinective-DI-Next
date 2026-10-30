import type { ReactElement, ReactNode } from 'react';
import * as RadixTooltip from '@radix-ui/react-tooltip';
import styles from './Tooltip.module.css';

export const TooltipProvider = ({ children }: { children: ReactNode }) => (
  <RadixTooltip.Provider delayDuration={400} skipDelayDuration={200}>
    {children}
  </RadixTooltip.Provider>
);

export interface TooltipProps {
  content: ReactNode;
  shortcut?: string;
  side?: 'top' | 'right' | 'bottom' | 'left';
  children: ReactElement;
}

/** Supplementary hint only: never the sole place information lives (WCAG 1.4.13). */
export function Tooltip({ content, shortcut, side = 'top', children }: TooltipProps) {
  return (
    <RadixTooltip.Root>
      <RadixTooltip.Trigger asChild>{children}</RadixTooltip.Trigger>
      <RadixTooltip.Portal>
        <RadixTooltip.Content side={side} sideOffset={6} className={styles.content} collisionPadding={8}>
          {content}
          {shortcut && <kbd className={styles.kbd}>{shortcut}</kbd>}
        </RadixTooltip.Content>
      </RadixTooltip.Portal>
    </RadixTooltip.Root>
  );
}
