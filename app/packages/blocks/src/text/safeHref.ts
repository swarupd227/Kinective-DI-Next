/** Kinective help domains allowed in agent text (spec 9.5). To be confirmed by Kinective. */
const HELP_DOMAINS = ['help.kinective.com', 'docs.kinective.com'];

/** Directions for a visit plan or a prospect route (FE-OBP-002): this path on this host, nothing else there. */
const isDirections = (u: URL) => u.hostname === 'www.google.com' && u.pathname === '/maps/dir/';

/** Allows DI Next deep links (relative, spec 11.4), allow-listed help domains and map directions only (FE-GEN-010). */
export function safeHref(url: string): string | null {
  if (url.startsWith('/') && !url.startsWith('//')) return url;
  try {
    const u = new URL(url);
    return u.protocol === 'https:' && (HELP_DOMAINS.includes(u.hostname) || isDirections(u)) ? u.toString() : null;
  } catch {
    return null;
  }
}
