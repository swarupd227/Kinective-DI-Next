import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { opensBeside, sourceApp, viewLabel } from '../src/shell/paneViews.ts';

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

describe('the pane knows every view', () => {
  // A module not built yet shows its placeholder as a page, so `m/:module` is left out.
  it('has a route for each view in the app router that opens beside a task', () => {
    const read = (f: string) => readFileSync(new URL(f, import.meta.url), 'utf-8');
    const pane = new Set([...read('../src/shell/PagePane.tsx').matchAll(/<Route path="\/([^"*]+?)\/?\*?"/g)].map((m) => m[1]!.replace(/\/$/, '')));
    const views = [...read('../src/router.tsx').matchAll(/path: '([^']+)'/g)].map((m) => m[1]!.replace(/\/?\*$/, '')).filter((p) => opensBeside(`/${p}`) && !p.includes(':'));
    expect(views.length).toBeGreaterThan(10);
    expect(views.filter((v) => !pane.has(v))).toEqual([]);
  });
});

describe('source chips', () => {
  it('open the module that owns a table, and leave other tables to the table viewer', () => {
    expect(sourceApp('mod_gi_goal')).toBe('gi');
    expect(sourceApp('cdm_loan_application')).toBe('lap');
    expect(sourceApp('ind_dealer_month')).toBe('indirect');
    expect(sourceApp('loan_accounts')).toBeUndefined();
    expect(sourceApp('cdm_loan')).toBeUndefined();
  });
});
