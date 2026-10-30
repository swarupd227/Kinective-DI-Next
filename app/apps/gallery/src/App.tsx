import { useEffect, useState } from 'react';
import { Monitor, Moon, Rows3, Rows4, Sun } from 'lucide-react';
import { AnnouncerProvider, PreferencesProvider, ToastProvider, SegmentedControl, TooltipProvider, usePreferences, type Density, type ThemePreference } from '@dinext/ui';
import { BlocksPage } from './BlocksPage.tsx';
import { Playground } from './Playground.tsx';
import styles from './App.module.css';

type Tab = 'blocks' | 'playground';

/** Hash routes keep every case linkable: #/blocks/chart_bar, #/playground. */
function useHashRoute(): [Tab, string | undefined, (tab: Tab, sub?: string) => void] {
  const parse = () => {
    const [, tab, sub] = window.location.hash.split('/');
    return [(tab === 'playground' ? 'playground' : 'blocks') as Tab, sub] as const;
  };
  const [route, setRoute] = useState(parse);
  useEffect(() => {
    const on = () => setRoute(parse());
    window.addEventListener('hashchange', on);
    return () => window.removeEventListener('hashchange', on);
  }, []);
  return [route[0], route[1], (tab, sub) => (window.location.hash = `/${tab}${sub ? `/${sub}` : ''}`)];
}

// Workbench-only convenience: remember theme and density in this browser. The product stores
// preferences on the server (spec 11.5).
const PREFS_KEY = 'dinext.workbench.prefs';
const loadPrefs = (): { theme: ThemePreference; density: Density } => {
  try {
    return { theme: 'system', density: 'comfortable', ...JSON.parse(localStorage.getItem(PREFS_KEY) ?? '{}') };
  } catch {
    return { theme: 'system', density: 'comfortable' };
  }
};
const savePrefs = (p: { theme: ThemePreference; density: Density }) => {
  try {
    localStorage.setItem(PREFS_KEY, JSON.stringify(p));
  } catch {
    // Storage can be unavailable (private mode); preferences then last for the session only.
  }
};

export function App() {
  const initial = loadPrefs();
  return (
    <PreferencesProvider initialTheme={initial.theme} initialDensity={initial.density} onChange={savePrefs}>
      <TooltipProvider>
        <AnnouncerProvider>
          <ToastProvider>
            <Workbench />
          </ToastProvider>
        </AnnouncerProvider>
      </TooltipProvider>
    </PreferencesProvider>
  );
}

function Workbench() {
  const [tab, sub, go] = useHashRoute();
  const { theme, setTheme, density, setDensity } = usePreferences();

  return (
    <div className={styles.app}>
      <a href="#main" className={styles.skip}>
        Skip to content
      </a>
      <header className={styles.topbar}>
        <div className={styles.brand}>
          <span className={styles.mark} aria-hidden>
            DI
          </span>
          <span className={styles.brandText}>
            <span className={styles.product}>DI Next</span>
            <span className={styles.sub}>Block workbench</span>
          </span>
        </div>
        <nav aria-label="Workbench" className={styles.tabs}>
          <a href="#/blocks" className={styles.tab} aria-current={tab === 'blocks' ? 'page' : undefined}>
            Blocks
          </a>
          <a href="#/playground" className={styles.tab} aria-current={tab === 'playground' ? 'page' : undefined}>
            Stream playground
          </a>
        </nav>
        <div className={styles.prefs}>
          <SegmentedControl<ThemePreference>
            label="Theme"
            iconOnly
            value={theme}
            onChange={setTheme}
            options={[
              { value: 'system', label: 'Match system', icon: <Monitor size={14} aria-hidden /> },
              { value: 'light', label: 'Light', icon: <Sun size={14} aria-hidden /> },
              { value: 'dark', label: 'Dark', icon: <Moon size={14} aria-hidden /> },
            ]}
          />
          <SegmentedControl<Density>
            label="Density"
            iconOnly
            value={density}
            onChange={setDensity}
            options={[
              { value: 'comfortable', label: 'Comfortable', icon: <Rows3 size={14} aria-hidden /> },
              { value: 'compact', label: 'Compact', icon: <Rows4 size={14} aria-hidden /> },
            ]}
          />
        </div>
      </header>
      <main id="main" className={styles.main} tabIndex={-1}>
        {tab === 'blocks' ? <BlocksPage caseId={sub} onSelect={(id) => go('blocks', id)} /> : <Playground />}
      </main>
    </div>
  );
}
