// The AI connection (Settings › AI connection): the Anthropic API key DI's agents use, set by an
// administrator on screen instead of in the deployment. The key is encrypted before it is stored and is
// never returned, logged or shown again: the screen sees its last four characters, who set it and when,
// and the result of the last connection test. A key set here takes over from the one in the deployment.
import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from 'node:crypto';
import type { Pool } from '@dinext/tenant-db';

const ALGO = 'aes-256-gcm';

/**
 * The key that encrypts a stored API key: DI_SECRET_KEY where the deployment sets it; else one derived
 * from the database connection string, which is private to each deployment and present in all of them.
 * If that string changes, the stored key can't be read and DI falls back to the deployment's own key
 * until an administrator enters it again.
 */
export const settingsKeyFrom = (env: NodeJS.ProcessEnv = process.env) => scryptSync(env.DI_SECRET_KEY ?? env.DI_DB_URL ?? 'dinext-local-development-only', 'dinext-ai-connection', 32);

/** What an Anthropic API key looks like: checked before any call is made with it. */
export const ANTHROPIC_KEY = /^sk-ant-[A-Za-z0-9_-]{20,200}$/;

export interface AiConnectionStatus {
  /** Where the key in use comes from: set on screen, the deployment's own, or none (DI answers offline). */
  source: 'settings' | 'deployment' | 'none';
  /** The last four characters of the key in use, never more. */
  last4: string | null;
  updatedBy: string | null;
  updatedAt: string | null;
  lastTest: { at: string; ok: boolean; message: string } | null;
}

const sql = (d: Date) => d.toISOString().slice(0, 23).replace('T', ' ');
const iso = (v: unknown) => (v instanceof Date ? v.toISOString() : v ? `${String(v).replace(' ', 'T')}Z` : null);

export class AiConnectionStore {
  constructor(
    private readonly pool: Pool,
    private readonly cipherKey = settingsKeyFrom(),
  ) {}

  private seal(secret: string) {
    const iv = randomBytes(12);
    const c = createCipheriv(ALGO, this.cipherKey, iv);
    const body = Buffer.concat([c.update(secret, 'utf8'), c.final()]);
    return [iv, c.getAuthTag(), body].map((b) => b.toString('base64')).join('.');
  }

  private unseal(sealed: string) {
    const [iv, tag, body] = sealed.split('.').map((s) => Buffer.from(s, 'base64')) as [Buffer, Buffer, Buffer];
    const d = createDecipheriv(ALGO, this.cipherKey, iv);
    d.setAuthTag(tag);
    return Buffer.concat([d.update(body), d.final()]).toString('utf8');
  }

  private async row() {
    const [rows] = await this.pool.query("SELECT value_sealed, last4, updated_by, updated_at, tested_at, test_ok, test_message FROM di_setting WHERE setting = 'anthropic_api_key'").catch(() => [[]]);
    return (rows as Record<string, unknown>[])[0] ?? null;
  }

  /** The key set on screen, or null (none set, the table isn't there yet, or it can't be read with this deployment's secret). */
  async key(): Promise<string | null> {
    const r = await this.row();
    if (!r?.value_sealed) return null;
    try {
      return this.unseal(String(r.value_sealed));
    } catch {
      return null;
    }
  }

  async status(deploymentKey: string | undefined): Promise<AiConnectionStatus> {
    const r = await this.row();
    const stored = r?.value_sealed ? await this.key() : null;
    const lastTest = r?.tested_at ? { at: iso(r.tested_at)!, ok: Number(r.test_ok) === 1, message: String(r.test_message ?? '') } : null;
    if (stored) return { source: 'settings', last4: String(r!.last4), updatedBy: String(r!.updated_by), updatedAt: iso(r!.updated_at), lastTest };
    if (deploymentKey) return { source: 'deployment', last4: deploymentKey.slice(-4), updatedBy: null, updatedAt: null, lastTest };
    return { source: 'none', last4: null, updatedBy: null, updatedAt: null, lastTest };
  }

  /** Stores a key (encrypted) as the one DI uses, with who set it. Only call it once the key has passed a test. */
  async save(secret: string, by: string) {
    const now = sql(new Date());
    await this.pool.query(
      `INSERT INTO di_setting (setting, value_sealed, last4, updated_by, updated_at) VALUES ('anthropic_api_key', ?, ?, ?, ?)
       ON DUPLICATE KEY UPDATE value_sealed = VALUES(value_sealed), last4 = VALUES(last4), updated_by = VALUES(updated_by), updated_at = VALUES(updated_at)`,
      [this.seal(secret), secret.slice(-4), by.slice(0, 80), now],
    );
  }

  /** Records the result of testing the key in use (never the key). */
  async recordTest(ok: boolean, message: string) {
    await this.pool
      .query(
        `INSERT INTO di_setting (setting, value_sealed, last4, updated_by, updated_at, tested_at, test_ok, test_message) VALUES ('anthropic_api_key', NULL, NULL, NULL, NULL, ?, ?, ?)
         ON DUPLICATE KEY UPDATE tested_at = VALUES(tested_at), test_ok = VALUES(test_ok), test_message = VALUES(test_message)`,
        [sql(new Date()), ok ? 1 : 0, message.slice(0, 200)],
      )
      .catch(() => {});
  }
}
