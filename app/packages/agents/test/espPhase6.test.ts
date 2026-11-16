// @vitest-environment node
// ESP phase 6: the cost model as data, and each loan, share, account and person's profit at each of the
// last 12 month-ends. The cost model is DI's standard one, so the latest month, times twelve, is the
// annual contribution DI's member profitability already shows.
import { describe, expect, it } from 'vitest';
import { MemberProfitService, ProfitabilityService, RelationshipService, type ActivityService } from '@dinext/di-core';
import { tenantPool, warehouseAvailable } from '@dinext/tenant-db';
import { BAND_FACTOR, DEPOSIT_COST, DEPOSIT_FTP, FTP_CURVE, LIFE_YEARS, LOAN_COST, LOSS_RATE } from '../../di-core/src/profitability.ts';
import { PROFIT_BAND_FACTOR, PROFIT_DEPOSIT_COST, PROFIT_DEPOSIT_FTP, PROFIT_FTP_CURVE, PROFIT_LIFE_YEARS, PROFIT_LOAN_COST, PROFIT_LOSS_RATE } from '../../tenant-db/src/espProfit.ts';
import { activityModule } from '../src/activity.ts';
import { predictiveModule } from '../src/predictive.ts';
import { member360 } from '../src/member.ts';

describe('the cost model', () => {
  it('is the one DI’s profitability answers use', () => {
    expect(PROFIT_FTP_CURVE).toEqual(FTP_CURVE);
    expect(PROFIT_DEPOSIT_FTP).toEqual(DEPOSIT_FTP);
    expect(PROFIT_LOSS_RATE).toEqual(LOSS_RATE);
    expect(PROFIT_LIFE_YEARS).toEqual(LIFE_YEARS);
    expect(PROFIT_LOAN_COST).toEqual(LOAN_COST);
    expect(PROFIT_DEPOSIT_COST).toEqual(DEPOSIT_COST);
    for (const score of [null, 600, 650, 700, 760]) for (const rating of [null, 5, 6, 7]) expect(PROFIT_BAND_FACTOR(score, rating)).toBe(BAND_FACTOR(score, rating));
  });

  it('sends transaction costs to the channel answer', () => {
    const act = activityModule({} as ActivityService);
    for (const q of ['What do our transactions cost by channel?', 'What’s our cost per transaction?', 'Show channel costs']) expect(act.request.test(q), q).toBe(true);
  });
});

for (const DB of ['dinext_t_test_cu', 'dinext_t_test_bank']) {
  const up = await warehouseAvailable(DB).then((ok) => ok && tenantPool(DB).query('SELECT 1 FROM hist_person_profit_month LIMIT 1').then(() => true, () => false));
  const type = DB.endsWith('bank') ? 'bank' : 'credit_union';
  const person = type === 'bank' ? 'customer' : 'member';
  describe.skipIf(!up)(`${DB}: phase 6`, () => {
    const pool = tenantPool(DB);
    const one = async (sql: string) => Number(((await pool.query(sql)) as unknown as [{ n: unknown }[]])[0][0]!.n ?? 0);
    const ctx = { user: { id: 'user:1', name: 'Test' }, modules: ['predictive', 'activity'], runId: 'r', threadId: 't' };

    it('keeps 12 month-ends, and adds each person’s up from their loans and shares', async () => {
      expect(await one('SELECT COUNT(DISTINCT month_end) AS n FROM hist_person_profit_month')).toBe(12);
      expect(await one('SELECT ABS((SELECT SUM(profit) FROM hist_loan_profit_month) + (SELECT SUM(profit) FROM hist_deposit_profit_month) - (SELECT SUM(profit) FROM hist_person_profit_month)) AS n')).toBeLessThan(50);
      expect(await one('SELECT ABS((SELECT SUM(profit) FROM hist_account_profit_month) - (SELECT SUM(profit) FROM hist_loan_profit_month l JOIN cdm_account_holding h ON h.account_kind = \'loan\' AND h.account_id = l.loan_id) - (SELECT SUM(profit) FROM hist_deposit_profit_month d JOIN cdm_account_holding h ON h.account_kind = \'deposit\' AND h.account_id = d.account_id)) AS n')).toBeLessThan(50);
      // Each line adds up: interest less the FTP charge, expected loss and servicing, plus fees.
      expect(await one('SELECT MAX(ABS(interest_income - ftp_charge - expected_loss - servicing + fee_income - profit)) AS n FROM hist_loan_profit_month')).toBeLessThan(0.05);
      expect(await one('SELECT MAX(ABS(ftp_credit - interest_expense - servicing + fee_income - profit)) AS n FROM hist_deposit_profit_month')).toBeLessThan(0.05);
      // The latest month's FTP curve is DI's standard one.
      expect(await one('SELECT COUNT(*) AS n FROM cdm_ftp_rate WHERE month_end = (SELECT MAX(month_end) FROM cdm_ftp_rate)')).toBe(FTP_CURVE.length);
      for (const [m, r] of FTP_CURVE) expect(await one(`SELECT rate_pct AS n FROM cdm_ftp_rate WHERE month_end = (SELECT MAX(month_end) FROM cdm_ftp_rate) AND max_term_months = ${m}`)).toBeCloseTo(r, 3);
    });

    it('ties the latest month, times twelve, to DI’s annual member profitability', async () => {
      const annual = (await new ProfitabilityService(pool, type).members()).reduce((s, m) => s + m.contribution, 0);
      const latest = (await one('SELECT SUM(profit) AS n FROM hist_person_profit_month WHERE month_end = (SELECT MAX(month_end) FROM hist_person_profit_month)')) * 12;
      // Month-end balances against today's, and empty shares DI still charges servicing for: within 6%.
      expect(Math.abs(latest - annual) / Math.abs(annual)).toBeLessThan(0.06);
    });

    it('adds the 12 months to the profitability answer, and the cost of each channel to the channel answer', async () => {
      const pred = predictiveModule({} as never, person, { svc: new ProfitabilityService(pool, type), pool }).tools.find((t) => t.name === 'pred_profit')!;
      const out = (await pred.run({ show: 'bottom' } as never, ctx as never)) as { text: string };
      expect(out.text).toMatch(/Over the last 12 month-ends it came to/);
      expect(out.text).toMatch(/cost more than they brought in/);
      const x = (await new MemberProfitService(pool).members())!;
      expect(x.losing.people).toBeGreaterThan(0);
      expect(x.most[0]!.profit).toBeGreaterThan(x.least[0]!.profit);
      const c = (await new MemberProfitService(pool).channels())!;
      expect(c.teller!.costShare).toBeGreaterThan(c.teller!.share);
      expect(c.quarterToDigital).toBeGreaterThan(0);
    });

    it('shows each person’s 12 months of profit on Member 360', async () => {
      const who = await one('SELECT party_id AS n FROM hist_person_profit_month GROUP BY party_id HAVING COUNT(*) = 12 ORDER BY SUM(profit) DESC LIMIT 1');
      const p = await new RelationshipService(pool, DB.replace('dinext_t_', ''), type).profile(who, {});
      expect(p.profit!.months).toBe(12);
      const overview = member360(p, 'r').data.sections.find((s) => s.kind === 'overview') as { figures: { label: string; value: number | null; detail?: string }[] };
      const fig = overview.figures.find((f) => f.label === 'Profit, 12 months')!;
      expect(fig.value).toBe(p.profit!.total);
      expect(fig.detail).toMatch(/^Before overhead: loans /);
    });
  });
}
