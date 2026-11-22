// @vitest-environment node
// Settings › AI connection: the Anthropic key set on screen is stored encrypted and never comes back,
// and a key pasted into a chat is dropped before anything keeps it. No call is made to Anthropic.
import { afterAll, describe, expect, it } from 'vitest';
import { AiConnectionStore, ANTHROPIC_KEY, settingsKeyFrom } from '@dinext/di-core';
import { CONVERSATIONS_SCHEMA, createPool, dbUrl } from '@dinext/tenant-db';
import { prescreen } from '../src/prescreen.ts';

const FAKE = 'sk-ant-api03-ThisIsNotARealKeyOnlyForTheTest_0123456789abcd';

describe('keys typed into a chat', () => {
  it('are dropped, never kept as a token, and flagged', () => {
    const r = prescreen(`Use this key: ${FAKE} please`);
    expect(r.text).toBe('Use this key: ⟨SECRET⟩ please');
    expect(r.findings).toEqual([{ kind: 'secret', token: '⟨SECRET⟩' }]);
    expect(JSON.stringify(r.tokens)).not.toContain('sk-ant');
    // The server drops it first; its mark is still flagged.
    expect(prescreen('Use this key: ⟨SECRET⟩').findings.map((f) => f.kind)).toEqual(['secret']);
    // Ordinary questions are untouched.
    expect(prescreen('How many members do we have?').findings).toEqual([]);
  });

  it('knows an Anthropic key when it sees one', () => {
    expect(ANTHROPIC_KEY.test(FAKE)).toBe(true);
    expect(ANTHROPIC_KEY.test('sk-123')).toBe(false);
    expect(ANTHROPIC_KEY.test('hello world')).toBe(false);
  });
});

const pool = createPool(`${dbUrl()}/${CONVERSATIONS_SCHEMA}`, { connectionLimit: 2 });
const up = await pool.query('SELECT 1 FROM di_setting LIMIT 1').then(() => true, () => false);
const before = up ? (((await pool.query("SELECT * FROM di_setting WHERE setting = 'anthropic_api_key'"))[0] as Record<string, unknown>[])[0] ?? null) : null;
afterAll(async () => {
  // Put back whatever was there.
  if (up) {
    await pool.query("DELETE FROM di_setting WHERE setting = 'anthropic_api_key'");
    if (before) await pool.query('INSERT INTO di_setting SET ?', [before]);
  }
  await pool.end();
});

describe.skipIf(!up)('the stored key', () => {
  it('is encrypted, shows only its last four characters, and comes back only to DI', async () => {
    await pool.query("DELETE FROM di_setting WHERE setting = 'anthropic_api_key'");
    const store = new AiConnectionStore(pool, settingsKeyFrom({ DI_SECRET_KEY: 'test-secret' }));
    expect((await store.status('sk-ant-deploymentKey000000000000wxyz')).source).toBe('deployment');
    await store.save(FAKE, 'Sam Taylor (user:1002)');
    await store.recordTest(true, 'Connected to Anthropic: the key works.');
    const [[row]] = (await pool.query("SELECT value_sealed, last4 FROM di_setting WHERE setting = 'anthropic_api_key'")) as unknown as [{ value_sealed: string; last4: string }[]];
    expect(row!.value_sealed).not.toContain('sk-ant');
    expect(row!.last4).toBe('abcd');
    expect(await store.key()).toBe(FAKE);
    const s = await store.status('sk-ant-deploymentKey000000000000wxyz');
    expect(s).toMatchObject({ source: 'settings', last4: 'abcd', updatedBy: 'Sam Taylor (user:1002)', lastTest: { ok: true } });
    expect(JSON.stringify(s)).not.toContain('sk-ant');
    // Another deployment's secret can't read it, so DI falls back to its own key.
    const other = new AiConnectionStore(pool, settingsKeyFrom({ DI_SECRET_KEY: 'another-secret' }));
    expect(await other.key()).toBeNull();
    expect((await other.status('sk-ant-deploymentKey000000000000wxyz')).source).toBe('deployment');
  });
});
