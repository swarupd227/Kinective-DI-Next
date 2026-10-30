import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';

export type ThemePreference = 'system' | 'light' | 'dark';
export type Density = 'comfortable' | 'compact';

interface PreferencesValue {
  theme: ThemePreference;
  /** The theme actually shown, after following the OS when the preference is "system". */
  resolvedTheme: 'light' | 'dark';
  density: Density;
  reducedMotion: boolean;
  setTheme: (t: ThemePreference) => void;
  setDensity: (d: Density) => void;
}

const PreferencesContext = createContext<PreferencesValue | null>(null);

function useMediaQuery(query: string): boolean {
  const [matches, setMatches] = useState(() => typeof window !== 'undefined' && window.matchMedia(query).matches);
  useEffect(() => {
    const mql = window.matchMedia(query);
    const onChange = () => setMatches(mql.matches);
    onChange();
    mql.addEventListener('change', onChange);
    return () => mql.removeEventListener('change', onChange);
  }, [query]);
  return matches;
}

export interface PreferencesProviderProps {
  children: ReactNode;
  initialTheme?: ThemePreference;
  initialDensity?: Density;
  /** Called when the user changes a preference; the app persists it to the server (spec 11.5). */
  onChange?: (prefs: { theme: ThemePreference; density: Density }) => void;
}

/** Applies theme and density to the document root (spec 10.2 FE-DS-002, 10.3). */
export function PreferencesProvider({ children, initialTheme = 'system', initialDensity = 'comfortable', onChange }: PreferencesProviderProps) {
  const [theme, setTheme] = useState<ThemePreference>(initialTheme);
  const [density, setDensity] = useState<Density>(initialDensity);
  const prefersDark = useMediaQuery('(prefers-color-scheme: dark)');
  const reducedMotion = useMediaQuery('(prefers-reduced-motion: reduce)');
  const resolvedTheme = theme === 'system' ? (prefersDark ? 'dark' : 'light') : theme;

  useEffect(() => {
    const root = document.documentElement;
    if (theme === 'system') delete root.dataset.theme;
    else root.dataset.theme = theme;
    root.dataset.density = density;
  }, [theme, density]);

  useEffect(() => {
    onChange?.({ theme, density });
  }, [theme, density, onChange]);

  const value = useMemo(
    () => ({ theme, resolvedTheme, density, reducedMotion, setTheme, setDensity }),
    [theme, resolvedTheme, density, reducedMotion],
  );
  return <PreferencesContext.Provider value={value}>{children}</PreferencesContext.Provider>;
}

const fallback: PreferencesValue = {
  theme: 'system',
  resolvedTheme: 'light',
  density: 'comfortable',
  reducedMotion: false,
  setTheme: () => {},
  setDensity: () => {},
};

export const usePreferences = () => useContext(PreferencesContext) ?? fallback;
