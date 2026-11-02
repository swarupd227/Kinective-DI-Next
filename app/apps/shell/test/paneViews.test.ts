import { describe, expect, it } from 'vitest';
import { opensBeside, viewLabel } from '../src/shell/paneViews.ts';

describe('views beside a task', () => {
  it('opens views beside the conversation, and leaves tasks and Home as pages', () => {
    for (const path of ['/m/lap?id=2689', '/m/gi', '/reports/alco_monthly_pack', '/workflows/referrals/inbox?id=1', '/members/mbr_1', '/tables']) expect(opensBeside(path), path).toBe(true);
    for (const path of ['/home', '/c/thr_1', '/c/new?q=hello', '/v1/exports/1', '/membership']) expect(opensBeside(path), path).toBe(false);
  });

  it('names a view after the app it sits under, the most specific first', () => {
    const apps = [{ label: 'Workflows', path: '/workflows' }, { label: 'Referrals', path: '/workflows/referrals/inbox' }, { label: 'Loan Pipeline', path: '/m/lap' }];
    expect(viewLabel('/m/lap?id=2689', apps)).toBe('Loan Pipeline');
    expect(viewLabel('/workflows/referrals/inbox?id=3', apps)).toBe('Referrals');
    expect(viewLabel('/somewhere', apps)).toBe('View');
  });
});
