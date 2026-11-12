// @vitest-environment node
// Compliance issues for one branch: "open complaints for Westport" lists that branch's issues, a
// branch outside the viewer's purview is refused, and a word that isn't a branch narrows nothing.
import { describe, expect, it } from 'vitest';
import { blockSchema } from '@dinext/block-schemas';
import { CoreError, IssueService } from '@dinext/di-core';
import { tenantPool, warehouseAvailable } from '@dinext/tenant-db';
import { complianceModule, namedBranch } from '../src/compliance.ts';

describe('the branch a compliance question names', () => {
  it('is read from "for", "at", "in" or a possessive, and question words are not branches', () => {
    expect(namedBranch('Show the open complaints for Westport')).toBe('Westport');
    expect(namedBranch('Any regulatory issues at Eastgate?')).toBe('Eastgate');
    expect(namedBranch('Show Northgate’s open issues')).toBe('Northgate');
    expect(namedBranch('Show open complaints for my branch')).toBeUndefined();
    expect(namedBranch('What’s open in October?')).toBeUndefined();
    expect(namedBranch('Which regulatory issues are open more than 3 weeks?')).toBeUndefined();
  });

  it('reaches the issues list as its branch filter', () => {
    const spec = complianceModule({} as IssueService, {} as never);
    expect(spec.plan!('Show the open complaints for Westport', {} as never)).toEqual({ tool: 'cpm_issues_list', args: { branch: 'Westport' } });
    expect(spec.plan!('Show the regulatory complaints at Eastgate', {} as never)).toEqual({ tool: 'cpm_issues_list', args: { branch: 'Eastgate', kind: 'regulatory' } });
    expect(spec.plan!('Show open complaints', {} as never)).toEqual({ tool: 'cpm_issues_list', args: {} });
  });
});

const SCHEMA = 'dinext_t_test_cu';
const up = await warehouseAvailable(SCHEMA);
describe.skipIf(!up)('compliance issues by branch on the credit union', () => {
  it('lists one branch’s issues and keeps to purview', async () => {
    const pool = tenantPool(SCHEMA);
    try {
      const issues = new IssueService(pool);
      const spec = complianceModule(issues, pool);
      const list = spec.tools.find((t) => t.name === 'cpm_issues_list')!;
      const elena = { user: { id: 'user:1001', name: 'Elena' }, modules: ['compliance'], runId: 'r', threadId: 't' };
      const marcus = { ...elena, user: { id: 'user:5120', name: 'Marcus Reed' }, purviewBranches: ['Westport'] };

      const all = await issues.list({}, {});
      const west = await issues.list({ branch: 'westport' }, {});
      expect(west.items.length).toBeGreaterThan(0);
      expect(west.items.every((i) => i.branch === 'Westport')).toBe(true);
      expect(west.count).toBe(all.items.filter((i) => i.branch === 'Westport').length);

      const out = (await list.run({ branch: 'Westport' } as never, elena)) as { text: string; blocks: unknown[] };
      expect(out.text).toContain(`${west.count} ${west.count === 1 ? 'issue' : 'issues'} at Westport`);
      for (const b of out.blocks) expect(blockSchema.safeParse(b).success).toBe(true);

      // Marcus sees Westport; asking for Eastgate is refused, not answered with Westport's issues.
      const mine = (await list.run({ branch: 'Westport' } as never, marcus)) as { text: string };
      expect(mine.text).toContain('at Westport');
      const away = await list.run({ branch: 'Eastgate' } as never, marcus).catch((e: unknown) => e);
      expect(away).toBeInstanceOf(CoreError);
      expect((away as CoreError).message).toMatch(/can’t show Eastgate’s issues\. Your access covers Westport/);

      // A word that isn't a branch narrows nothing.
      const any = (await list.run({ branch: 'Somewhere' } as never, elena)) as { text: string };
      expect(any.text).not.toMatch(/ at Somewhere/);
      expect(any.text).toContain(`${all.count} ${all.count === 1 ? 'issue' : 'issues'}`);
    } finally {
      await pool.end();
    }
  });
});
