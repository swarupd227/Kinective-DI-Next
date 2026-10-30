import { createContext, useCallback, useContext, useMemo, useRef, useState, type ReactNode } from 'react';

type Politeness = 'polite' | 'assertive';

interface AnnouncerApi {
  announce: (message: string, politeness?: Politeness) => void;
}

const AnnouncerContext = createContext<AnnouncerApi>({ announce: () => {} });

/**
 * App-wide live regions (spec 10.8). Streaming text and step changes go to the polite region;
 * approval cards announce once through the assertive region. Repeated messages are re-announced
 * by clearing the region first.
 */
export function AnnouncerProvider({ children }: { children: ReactNode }) {
  const [polite, setPolite] = useState('');
  const [assertive, setAssertive] = useState('');
  const timers = useRef<ReturnType<typeof setTimeout>[]>([]);

  const announce = useCallback((message: string, politeness: Politeness = 'polite') => {
    const set = politeness === 'assertive' ? setAssertive : setPolite;
    set('');
    timers.current.push(setTimeout(() => set(message), 50));
  }, []);

  const api = useMemo(() => ({ announce }), [announce]);

  return (
    <AnnouncerContext.Provider value={api}>
      {children}
      <div className="dn-visually-hidden" role="status" aria-live="polite" aria-atomic="true">
        {polite}
      </div>
      <div className="dn-visually-hidden" role="alert" aria-live="assertive" aria-atomic="true">
        {assertive}
      </div>
    </AnnouncerContext.Provider>
  );
}

export const useAnnouncer = () => useContext(AnnouncerContext);
