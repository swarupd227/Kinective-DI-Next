// After a deploy, a tab opened on the previous release still runs the old page, and its next lazy
// import asks for a code file the new release replaced. That is not a fault in the page: reloading
// once fetches the new release. Guarded so a real outage can't loop the page.
const KEY = 'di-reloaded-for-release';
const WINDOW_MS = 30_000;

/** The browsers' wording when a dynamically imported module or its CSS can't be fetched. */
export const isStaleChunkError = (e: unknown) => /Failed to fetch dynamically imported module|error loading dynamically imported module|Importing a module script failed|Unable to preload CSS|Loading chunk \S+ failed/i.test(String((e as { message?: string })?.message ?? e));

/** Reloads unless it already did so in the last 30 seconds; says whether it reloaded. */
export function reloadForNewRelease(): boolean {
  let last = 0;
  try {
    last = Number(sessionStorage.getItem(KEY) ?? 0);
  } catch {
    // Storage can be blocked; reload anyway, once per page.
  }
  if (Date.now() - last < WINDOW_MS) return false;
  try {
    sessionStorage.setItem(KEY, String(Date.now()));
  } catch {
    // As above.
  }
  window.location.reload();
  return true;
}

/** Catches the failures before any route sees them: Vite's preload event and unhandled imports. */
export function watchForNewRelease() {
  window.addEventListener('vite:preloadError', (event) => {
    if (reloadForNewRelease()) event.preventDefault();
  });
  window.addEventListener('unhandledrejection', (event) => {
    if (isStaleChunkError(event.reason) && reloadForNewRelease()) event.preventDefault();
  });
}
