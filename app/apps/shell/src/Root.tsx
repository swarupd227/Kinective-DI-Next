import { Outlet } from 'react-router';
import { AnnouncerProvider, PreferencesProvider, ToastProvider, TooltipProvider, type Density, type ThemePreference } from '@dinext/ui';
import { SessionProvider } from './session/SessionProvider.tsx';
import { VoiceProvider } from './voice/VoiceProvider.tsx';

// Theme and density belong in the user's server-side preferences (spec 11.5). Until the
// preferences endpoint exists they are remembered in this browser; they hold no institution data.
const PREFS_KEY = 'dinext.prefs';
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
    // Storage can be unavailable; preferences then last for this session only.
  }
};

const initial = loadPrefs();

export function Root() {
  return (
    <PreferencesProvider initialTheme={initial.theme} initialDensity={initial.density} onChange={savePrefs}>
      <TooltipProvider>
        <AnnouncerProvider>
          <ToastProvider>
            <SessionProvider>
              <VoiceProvider>
                <Outlet />
              </VoiceProvider>
            </SessionProvider>
          </ToastProvider>
        </AnnouncerProvider>
      </TooltipProvider>
    </PreferencesProvider>
  );
}
