import { useSyncExternalStore } from 'react';

/** Spec 10.10 breakpoints: desktop >= 1280, laptop 1024-1279, tablet 768-1023, phone < 768. */
export type Breakpoint = 'desktop' | 'laptop' | 'tablet' | 'phone';

const queries: [Breakpoint, string][] = [
  ['desktop', '(min-width: 1280px)'],
  ['laptop', '(min-width: 1024px)'],
  ['tablet', '(min-width: 768px)'],
];

function current(): Breakpoint {
  if (typeof window === 'undefined') return 'desktop';
  return queries.find(([, q]) => window.matchMedia(q).matches)?.[0] ?? 'phone';
}

function subscribe(cb: () => void) {
  const lists = queries.map(([, q]) => window.matchMedia(q));
  lists.forEach((l) => l.addEventListener('change', cb));
  return () => lists.forEach((l) => l.removeEventListener('change', cb));
}

export const useBreakpoint = () => useSyncExternalStore(subscribe, current, () => 'desktop' as Breakpoint);
