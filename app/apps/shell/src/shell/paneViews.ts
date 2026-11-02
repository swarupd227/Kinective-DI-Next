// Which views can open beside a conversation, so a task keeps its place while the person checks one.
// A conversation, Home and anything outside the app still navigate as a page.

const BESIDE = /^\/(m\/|reports\b|tables\b|workflows\b|calendar\b|files\b|datalogs\b|queries\b|members\b|customers\b|admin\b|tasks\b|dq\b|integrations\b)/;

export const opensBeside = (path: string) => BESIDE.test(path);

/** The app's own name for a view: the longest app path that the link sits under. */
export function viewLabel(path: string, apps: { label: string; path: string }[]) {
  const route = path.split(/[?#]/)[0]!;
  const match = apps.filter((a) => route === a.path || route.startsWith(`${a.path}/`)).sort((a, b) => b.path.length - a.path.length)[0];
  return match?.label ?? 'View';
}
