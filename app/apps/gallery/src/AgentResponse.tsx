import type { ReactNode } from 'react';
import { ChevronRight, Sparkles } from 'lucide-react';
import styles from './AgentResponse.module.css';

/**
 * An agent turn on the canvas: an article headed by the routing ("DI Concierge → Analytics Q&A",
 * spec 6.2) followed by its blocks (spec 10.8: each response is an article with a heading).
 */
export function AgentResponse({ agent, children, footer }: { agent: string; children: ReactNode; footer?: ReactNode }) {
  const routed = agent !== 'DI Concierge';
  return (
    <div className={styles.turn}>
      <div className={styles.avatar} aria-hidden>
        <Sparkles size={14} />
      </div>
      <div className={styles.body}>
        <h3 className={styles.who}>
          DI Concierge
          {routed && (
            <>
              <ChevronRight size={12} aria-hidden className={styles.arrow} />
              <span className="dn-visually-hidden">routed to </span>
              <span className={styles.agent}>{agent}</span>
            </>
          )}
        </h3>
        <div className={styles.blocks}>{children}</div>
        {footer}
      </div>
    </div>
  );
}
