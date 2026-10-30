/** Kinective help domains allowed in agent text (spec 9.5). To be confirmed by Kinective. */
const HELP_DOMAINS = ['help.kinective.com', 'docs.kinective.com'];

/** Allows DI Next deep links (relative, spec 11.4) and allow-listed help domains only (FE-GEN-010). */
export function safeHref(url: string): string | null {
  if (url.startsWith('/') && !url.startsWith('//')) return url;
  try {
    const u = new URL(url);
    return u.protocol === 'https:' && HELP_DOMAINS.includes(u.hostname) ? u.toString() : null;
  } catch {
    return null;
  }
}
