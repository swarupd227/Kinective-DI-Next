// @vitest-environment node
// ESP phase 7: membership applications, alerts, matching people across sources, and campaign touches.
// Each ties to data DI already has: the people who joined, the transactions and accounts behind each
// alert, and the accounts each campaign is credited with.
import { describe, expect, it } from 'vitest';
import { EngagementService, type CampaignService, type MembershipService } from '@dinext/di-core';
import { tenantPool, warehouseAvailable } from '@dinext/tenant-db';
import { membershipModule, APPLICATION_REQUEST } from '../src/membership.ts';
import { campaignModule, TOUCH_REQUEST } from '../src/moreModules.ts';
import { activityModule } from '../src/activity.ts';

describe('routing', () => {
  it('sends applications, touches and alerts to their tools, and leaves loan applications with the pipeline', () => {
    const mem = membershipModule({} as MembershipService, {} as EngagementService);
    const plan = (t: string) => (mem.plan(t, {} as never) as { tool?: string }).tool;
    for (const q of ['How many membership applications did we get?', 'Show abandoned online applications', 'Are any applicants already members?', 'Show the account-opening applications']) {
      expect(mem.request.test(q), q).toBe(true);
      expect(plan(q), q).toBe('mem_applications');
    }
    for (const q of ['How many loan applications are pending?', 'Show the auto loan applications']) expect(APPLICATION_REQUEST.test(q), q).toBe(false);
    expect(plan('How fast are we growing?')).toBe('mem_growth');
    const cmp = campaignModule({} as CampaignService, null, {} as EngagementService);
    for (const q of ['How often do we reach members?', 'Who did the campaigns reach?', 'Show contact frequency', 'Are we over-contacting members?']) {
      expect(TOUCH_REQUEST.test(q) || cmp.request.test(q), q).toBe(true);
      expect((cmp.plan(q, {} as never) as { tool?: string }).tool, q).toBe('cmp_touches');
    }
    const act = activityModule({} as never, null, {} as EngagementService);
    for (const q of ['Show this week’s member alerts', 'Which members had a large deposit this week?', 'Any alerts on my members?']) {
      expect(act.request.test(q), q).toBe(true);
      expect((act.plan(q, {} as never) as { tool?: string }).tool, q).toBe('act_alerts');
    }
  });
});

for (const DB of ['dinext_t_test_cu', 'dinext_t_test_bank']) {
  const up = await warehouseAvailable(DB).then((ok) => ok && tenantPool(DB).query('SELECT 1 FROM cmp_touch LIMIT 1').then(() => true, () => false));
  describe.skipIf(!up)(`${DB}: phase 7`, () => {
    const pool = tenantPool(DB);
    const one = async (sql: string) => Number(((await pool.query(sql)) as unknown as [{ n: unknown }[]])[0][0]!.n ?? 0);

    it('gives everyone who joined in the last 24 months the application they opened through', async () => {
      const joined = await one("SELECT COUNT(*) AS n FROM cdm_party WHERE is_member = 1 AND join_date > DATE_SUB('2026-10-25', INTERVAL 730 DAY) AND join_date <= '2026-10-25'");
      expect(await one('SELECT COUNT(*) AS n FROM cdm_membership_application a JOIN cdm_application_status s ON s.status_id = a.status_id WHERE s.booked = 1')).toBe(joined);
      expect(await one('SELECT COUNT(*) AS n FROM cdm_membership_application a JOIN cdm_party p ON p.party_id = a.party_id WHERE a.opened_date <> p.join_date OR a.applied > p.join_date')).toBe(0);
      // Every opened application has its primary applicant, who is the person who joined.
      expect(await one("SELECT COUNT(*) AS n FROM cdm_membership_application a LEFT JOIN cdm_membership_applicant ap ON ap.application_id = a.application_id AND ap.role = 'Primary' WHERE a.party_id IS NOT NULL AND (ap.party_id IS NULL OR ap.party_id <> a.party_id)")).toBe(0);
      // Denied ones say why; abandoned ones were online.
      expect(await one('SELECT COUNT(*) AS n FROM cdm_membership_application WHERE status_id = 6 AND denial_reason IS NULL')).toBe(0);
      expect(await one("SELECT COUNT(*) AS n FROM cdm_membership_application WHERE status_id = 8 AND channel = 'Branch'")).toBe(0);
      // Applicants matched to someone already on file are real people on file.
      expect(await one('SELECT COUNT(*) AS n FROM cdm_person_match m LEFT JOIN cdm_party p ON p.party_id = m.party_id WHERE m.party_id IS NOT NULL AND p.party_id IS NULL')).toBe(0);
      expect(await one("SELECT COUNT(*) AS n FROM cdm_person_match WHERE status IN ('Confirmed', 'Possible match')")).toBeGreaterThan(5);
    });

    it('raises each alert from the data behind it', async () => {
      expect(await one("SELECT COUNT(*) AS n FROM cdm_account_alert x JOIN cdm_alert_type t ON t.type_id = x.type_id WHERE t.code = 'OVERDRAFT'")).toBe(await one("SELECT COUNT(*) AS n FROM cdm_share_transaction s JOIN cdm_account_holding h ON h.account_kind = 'deposit' AND h.account_id = s.account_id WHERE s.code = 'FEE-OD'"));
      expect(await one("SELECT COUNT(*) AS n FROM cdm_account_alert x JOIN cdm_alert_type t ON t.type_id = x.type_id WHERE t.code = 'LOAN_LATE'")).toBe(await one("SELECT COUNT(*) AS n FROM cdm_loan l JOIN cdm_account_holding h ON h.account_kind = 'loan' AND h.account_id = l.loan_id WHERE l.close_date IS NULL AND l.charge_off_date IS NULL AND l.balance > 0 AND l.days_delinquent >= 30"));
      expect(await one("SELECT COUNT(*) AS n FROM cdm_person_alert x JOIN cdm_alert_type t ON t.type_id = x.type_id WHERE t.code = 'DD_STOPPED'")).toBe(await one("SELECT COUNT(*) AS n FROM cdm_digital_usage WHERE direct_deposit_status = 'stopped' AND direct_deposit_changed > DATE_SUB('2026-10-25', INTERVAL 30 DAY) AND direct_deposit_changed <= '2026-10-25'"));
      const a = (await new EngagementService(pool).alerts(30))!;
      expect(a.total).toBeGreaterThan(100);
      expect(a.byType.length).toBeGreaterThanOrEqual(6);
    });

    it('sends each campaign to as many as it says, including everyone it is credited with, before they opened', async () => {
      expect(await one("SELECT COUNT(*) AS n FROM cmp_campaign c WHERE c.launched <= '2026-10-25' AND c.sent <> (SELECT COUNT(*) FROM cmp_touch t WHERE t.campaign_id = c.campaign_id AND t.action <> 'Reminder')")).toBe(0);
      expect(await one('SELECT COUNT(*) AS n FROM cmp_attribution a WHERE NOT EXISTS (SELECT 1 FROM cmp_touch t WHERE t.campaign_id = a.campaign_id AND t.party_id = a.party_id AND t.was_member = 1 AND t.touched <= a.opened)')).toBe(0);
      const x = (await new EngagementService(pool).touches(365))!;
      expect(x.reached).toBeGreaterThan(1000);
      expect(x.campaigns.some((c) => c.nonMembers > 0 && c.joined > 0)).toBe(true);
    });
  });
}
