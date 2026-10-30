// The five-region shell (spec 6.2, FE-EXP-001): top bar, navigation rail, canvas with the
// conversation bar, workspace pane and agent activity rail. Layout adapts per spec 10.10.
import { lazy, Suspense, useEffect, useRef, useState } from 'react';
import { Outlet, useLocation, useMatch } from 'react-router';
import clsx from 'clsx';
import { TopBar } from './TopBar.tsx';
import { NavRail } from './NavRail.tsx';
import { ConversationBar } from './ConversationBar.tsx';
import { WorkspacePane } from './WorkspacePane.tsx';
import { ActivityRail } from './ActivityRail.tsx';
import { IdleTimeout } from '../session/IdleTimeout.tsx';
import { useUi } from './uiStore.ts';
import { useBreakpoint } from './useBreakpoint.ts';
import styles from './AppShell.module.css';

// The palette (cmdk and its dialog) loads the first time it opens.
const CommandPalette = lazy(() => import('./CommandPalette.tsx').then((m) => ({ default: m.CommandPalette })));

const REGIONS = ['topbar', 'nav', 'canvas', 'bar', 'workspace', 'rail'];

export function AppShell() {
  const bp = useBreakpoint();
  const location = useLocation();
  const thread = useMatch('/c/:threadId/*');
  const threadId = thread?.params.threadId && thread.params.threadId !== 'new' ? thread.params.threadId : undefined;
  // Classic views open at full width with the conversation bar collapsed to one line (FE-EXP-002).
  const classic = /^\/(tables|reports|workflows|calendar|files|datalogs|queries|admin|members|customers|m)\b/.test(location.pathname);
  const { workspace, workspaceWidth, workspaceMaximized, setPalette, setMobileNav, paletteOpen } = useUi();
  // Once opened, the palette stays mounted so it can animate closed and reopen instantly.
  const [paletteUsed, setPaletteUsed] = useState(false);
  if (paletteOpen && !paletteUsed) setPaletteUsed(true);
  const canvasRef = useRef<HTMLDivElement>(null);

  // Global shortcuts (spec 10.7): Ctrl/Cmd+K palette from anywhere, F6 cycles regions.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        setPalette(true);
      } else if (e.key === 'F6') {
        e.preventDefault();
        const present = REGIONS.map((r) => document.querySelector<HTMLElement>(`[data-region="${r}"]`)).filter((el): el is HTMLElement => !!el);
        const active = present.findIndex((el) => el.contains(document.activeElement));
        const next = present[(active + (e.shiftKey ? -1 : 1) + present.length) % present.length];
        next?.focus();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [setPalette]);

  useEffect(() => setMobileNav(false), [location.pathname, setMobileNav]);

  const side = workspace && bp === 'desktop' && !workspaceMaximized;
  const overlay = workspace && !side ? (workspaceMaximized ? 'max' : bp === 'laptop' ? 'overlay' : 'sheet') : null;

  return (
    <div className={clsx(styles.shell, styles[bp])} style={{ ['--ws-width' as string]: `${workspaceWidth}%` }}>
      <a href="#canvas" className={styles.skip}>
        Skip to content
      </a>
      <TopBar threadId={threadId} />
      <div className={clsx(styles.body, side && styles.withWorkspace)}>
        <NavRail />
        <div className={styles.canvasCol}>
          <div
            id="canvas"
            ref={canvasRef}
            className={clsx(styles.canvas, overlay === 'max' && styles.hidden)}
            data-region="canvas"
            tabIndex={-1}
          >
            <Outlet />
          </div>
          {overlay && <WorkspacePane mode={overlay} />}
          <ConversationBar threadId={threadId} collapsedByDefault={classic} />
        </div>
        {side && <WorkspacePane mode="side" />}
        <ActivityRail />
      </div>
      {paletteUsed && (
        <Suspense fallback={null}>
          <CommandPalette />
        </Suspense>
      )}
      <IdleTimeout />
    </div>
  );
}
