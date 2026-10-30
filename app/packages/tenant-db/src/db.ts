// Warehouse connection. Local development uses the MySQL container from docker-compose.yml; the
// Azure move points DI_DB_URL at Azure Database for MySQL with no code change.
import mysql from 'mysql2/promise';

export const DEFAULT_DB_URL = 'mysql://dinext:dinext_local@127.0.0.1:3307';
export const ADMIN_DB_URL = 'mysql://root:dinext_local_root@127.0.0.1:3307';

export const dbUrl = () => process.env.DI_DB_URL ?? DEFAULT_DB_URL;

/**
 * Azure Database for MySQL requires TLS. DI_DB_SSL=1 turns it on with certificate checks; Node's
 * built-in CA list includes the roots Azure uses. The local Docker database runs without TLS.
 */
export const dbSsl = () => (process.env.DI_DB_SSL === '1' ? { ssl: { minVersion: 'TLSv1.2', rejectUnauthorized: true } } : {});

export function createPool(url = dbUrl(), options: mysql.PoolOptions = {}) {
  return mysql.createPool({
    uri: url,
    ...dbSsl(),
    connectionLimit: 8,
    // DECIMAL columns come back as strings unless asked; the semantic layer formats numbers itself.
    decimalNumbers: true,
    dateStrings: true,
    timezone: 'Z',
    ...options,
  });
}

export type Pool = mysql.Pool;

/** A pool bound to one tenant's schema with the read-only application account. */
export const tenantPool = (schema: string, options: mysql.PoolOptions = {}) => createPool(`${dbUrl()}/${schema}`, options);

/** True when the warehouse answers within a second; integration tests skip otherwise. */
export async function warehouseAvailable(schema: string): Promise<boolean> {
  const pool = tenantPool(schema, { connectTimeout: 1500, connectionLimit: 1 });
  try {
    await pool.query('SELECT 1 FROM meta_build LIMIT 1');
    return true;
  } catch {
    return false;
  } finally {
    await pool.end().catch(() => {});
  }
}
