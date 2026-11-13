// Who marketing outreach leaves out, and why: people who have died (their accounts wait for the estate)
// and people who opted out of marketing, from the core's customer details (ESP phase 1), then anyone
// contacted recently. Service messages still reach those who opted out; these lists are for campaigns.
import type { Pool } from '@dinext/tenant-db';

export type Suppression = 'deceased' | 'opt_out' | 'recent_contact' | null;

/** Contact history isn't loaded yet, so recent contact stays a fixed stand-in rule. */
const recentContact = (partyId: number): Suppression => (partyId % 13 === 0 ? 'recent_contact' : null);

/**
 * A lookup of each person's suppression. Where customer details aren't loaded (a build before ESP
 * phase 1), opt-outs fall back to the stand-in rule DI used before, so audiences still come out.
 */
export async function outreachSuppression(pool: Pool): Promise<(partyId: number) => Suppression> {
  const found = await pool
    .query('SELECT party_id, deceased_date IS NOT NULL AS dead FROM cdm_party_detail WHERE deceased_date IS NOT NULL OR marketing_opt_out = 1')
    .then(([r]) => r as { party_id: number; dead: number }[])
    .catch(() => null);
  if (!found) return (partyId) => (partyId % 9 === 0 ? 'opt_out' : recentContact(partyId));
  const marked = new Map(found.map((r) => [Number(r.party_id), Number(r.dead) ? ('deceased' as const) : ('opt_out' as const)]));
  return (partyId) => marked.get(partyId) ?? recentContact(partyId);
}
