// The audit log hands every line to the permanent audit store as well as to its files.
import { mkdtempSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { AuditLog } from '../src/index.ts';

type Kept = Parameters<Parameters<AuditLog['keep']>[0]>[0];

describe('audit log', () => {
  it('sends each turn, decision, record view and unmatched question to the audit store', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'di-audit-keep-'));
    const audit = new AuditLog(dir);
    const kept: Kept[] = [];
    audit.keep(async (e) => void kept.push(e));
    await audit.record({ tenant: 'tnt', userId: 'user:1', threadId: 'thr_1', runId: 'R-1', question: 'q', maskedIdentifiers: 0, route: { intent: 'data_question', agent: 'analytics', confidence: 1, mode: 'offline' }, toolCalls: [], outcome: 'answer', numericRemovals: [], usage: [] });
    await audit.event({ eventType: 'ai.approval.approved', tenant: 'tnt', userId: 'user:1', threadId: 'thr_1', runId: 'R-1', approvalId: 'apr_1', channel: 'click' });
    await audit.access({ tenant: 'tnt', userId: 'user:1', partyId: 7, via: 'workspace' });
    await audit.unmatched({ tenant: 'tnt', question: 'wallet share', unknownTerms: ['wallet'], closest: [] });

    expect(kept.map((e) => e.eventType)).toEqual(['ai.run', 'ai.approval.approved', 'relationship.profile.viewed', 'ai.question.unmatched']);
    expect(kept[0]).toMatchObject({ tenant: 'tnt', userId: 'user:1', threadId: 'thr_1', runId: 'R-1' });
    expect(kept[0]!.body).toMatchObject({ outcome: 'answer', route: { agent: 'analytics' } });
    expect(kept[1]).toMatchObject({ approvalId: 'apr_1', body: { channel: 'click' } });
    // An empty ID is left out rather than kept as an empty string.
    expect(kept[2]!.threadId).toBeUndefined();
    // The files are still written.
    expect(readdirSync(join(dir, 'audit'))).toHaveLength(1);
  });

  it('still writes its files when the audit store fails', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'di-audit-keep-'));
    const audit = new AuditLog(dir);
    audit.keep(async () => {
      throw new Error('store down');
    });
    await audit.event({ eventType: 'ai.action.executed', tenant: 'tnt', userId: 'u', threadId: 't', runId: 'R-2', approvalId: 'a' });
    expect(readdirSync(join(dir, 'audit'))).toHaveLength(1);
  });
});
