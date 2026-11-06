// API connections (spec Integrations > APIs: connections, saved requests, credentials, request log),
// and a stand-in for one external platform. Two parts:
// - DI's own store: sign-in details (the secret sealed by DI Core), connections, saved requests, the
//   request log, audiences sent to a platform, and the campaign results pulled back.
// - "Relay Marketing", a simulated marketing platform. Its tables stand in for the vendor's own
//   systems: DI never reads them directly, only through the platform's API. It already holds the
//   institution's email and digital campaigns, so the first pull has results to bring back.
import type mysql from 'mysql2/promise';
import { MODULE_FIXTURES } from './modules.ts';

export const APIS_DDL = [
  `CREATE TABLE IF NOT EXISTS api_credential (
     credential_id INT AUTO_INCREMENT PRIMARY KEY,
     kind VARCHAR(20) NOT NULL,
     label VARCHAR(80) NOT NULL,
     placement VARCHAR(60) NULL,
     username VARCHAR(120) NULL,
     secret TEXT NOT NULL,
     token_url VARCHAR(255) NULL,
     created_by VARCHAR(40) NOT NULL,
     created_at DATETIME NOT NULL
   )`,
  `CREATE TABLE IF NOT EXISTS api_connection (
     connection_id INT AUTO_INCREMENT PRIMARY KEY,
     name VARCHAR(80) NOT NULL,
     platform VARCHAR(40) NOT NULL,
     base_url VARCHAR(255) NOT NULL,
     credential_id INT NOT NULL,
     access VARCHAR(20) NOT NULL,
     log_success TINYINT NOT NULL DEFAULT 1,
     status VARCHAR(20) NOT NULL,
     created_by VARCHAR(40) NOT NULL,
     created_by_name VARCHAR(80) NOT NULL,
     approval_id VARCHAR(40) NOT NULL,
     created_at DATETIME NOT NULL
   )`,
  `CREATE TABLE IF NOT EXISTS api_request (
     request_id INT AUTO_INCREMENT PRIMARY KEY,
     connection_id INT NOT NULL,
     name VARCHAR(80) NOT NULL,
     method VARCHAR(8) NOT NULL,
     endpoint VARCHAR(255) NOT NULL,
     purpose VARCHAR(20) NOT NULL,
     paging VARCHAR(20) NOT NULL,
     root_path VARCHAR(80) NULL,
     watermark_param VARCHAR(40) NULL,
     watermark VARCHAR(40) NULL,
     target VARCHAR(64) NULL,
     schedule VARCHAR(40) NULL,
     last_run_at DATETIME NULL,
     last_rows INT NULL
   )`,
  `CREATE TABLE IF NOT EXISTS api_request_log (
     log_id INT AUTO_INCREMENT PRIMARY KEY,
     connection_id INT NOT NULL,
     request_at DATETIME(3) NOT NULL,
     response_at DATETIME(3) NULL,
     method VARCHAR(8) NOT NULL,
     endpoint VARCHAR(255) NOT NULL,
     parameters TEXT NULL,
     request_headers TEXT NULL,
     body MEDIUMTEXT NULL,
     body_sealed TINYINT NOT NULL DEFAULT 0,
     response_headers TEXT NULL,
     status_code INT NULL,
     response_body MEDIUMTEXT NULL,
     response_sealed TINYINT NOT NULL DEFAULT 0,
     is_error TINYINT NOT NULL DEFAULT 0,
     error_message VARCHAR(255) NULL,
     run_id VARCHAR(40) NULL,
     KEY by_conn (connection_id, log_id)
   )`,
  `CREATE TABLE IF NOT EXISTS cmp_push (
     push_id INT AUTO_INCREMENT PRIMARY KEY,
     audience_name VARCHAR(80) NOT NULL,
     category VARCHAR(40) NOT NULL,
     connection_id INT NOT NULL,
     external_list_id VARCHAR(40) NOT NULL,
     external_campaign_id VARCHAR(40) NOT NULL,
     campaign_name VARCHAR(80) NOT NULL,
     contacts INT NOT NULL,
     fields VARCHAR(120) NOT NULL,
     pushed_by VARCHAR(40) NOT NULL,
     pushed_by_name VARCHAR(80) NOT NULL,
     approval_id VARCHAR(40) NOT NULL,
     pushed_at DATETIME NOT NULL
   )`,
  // The reference sent in place of a member number. Only DI can turn it back into a member.
  `CREATE TABLE IF NOT EXISTS cmp_push_member (
     push_id INT NOT NULL,
     ref VARCHAR(24) NOT NULL,
     party_id INT NOT NULL,
     PRIMARY KEY (push_id, ref)
   )`,
  `CREATE TABLE IF NOT EXISTS cmp_platform_metric (
     external_campaign_id VARCHAR(40) PRIMARY KEY,
     connection_id INT NOT NULL,
     campaign_id INT NULL,
     push_id INT NULL,
     name VARCHAR(80) NOT NULL,
     channel VARCHAR(20) NOT NULL,
     status VARCHAR(20) NOT NULL,
     sent INT NOT NULL,
     delivered INT NOT NULL,
     opened INT NOT NULL,
     clicked INT NOT NULL,
     unsubscribed INT NOT NULL,
     clicked_refs MEDIUMTEXT NULL,
     sent_at DATETIME NULL,
     updated_at DATETIME NOT NULL,
     pulled_at DATETIME NOT NULL
   )`,
  // ---- Relay Marketing (simulated platform) ----
  `CREATE TABLE IF NOT EXISTS sim_relay_list (
     list_id VARCHAR(40) PRIMARY KEY,
     name VARCHAR(80) NOT NULL,
     contacts INT NOT NULL,
     refs MEDIUMTEXT NOT NULL,
     created_at DATETIME NOT NULL
   )`,
  `CREATE TABLE IF NOT EXISTS sim_relay_campaign (
     campaign_id VARCHAR(40) PRIMARY KEY,
     list_id VARCHAR(40) NULL,
     name VARCHAR(80) NOT NULL,
     channel VARCHAR(20) NOT NULL,
     tag VARCHAR(40) NULL,
     status VARCHAR(20) NOT NULL,
     sent INT NOT NULL,
     delivered INT NOT NULL,
     opened INT NOT NULL,
     clicked INT NOT NULL,
     unsubscribed INT NOT NULL,
     clicked_refs MEDIUMTEXT NULL,
     sent_at DATETIME NULL,
     updated_at DATETIME NOT NULL
   )`,
];

export const APIS_WRITE_TABLES = ['api_credential', 'api_connection', 'api_request', 'api_request_log', 'cmp_push', 'cmp_push_member', 'cmp_platform_metric', 'sim_relay_list', 'sim_relay_campaign'];

/** The simulated platform's address. `.example` is reserved, so it can never reach a real host. */
export const RELAY_HOST = 'api.relay-marketing.example';
export const RELAY_BASE_URL = `https://${RELAY_HOST}/v1`;
/** The demo account's key, as the platform issued it. A test value; real keys come from the vendor. */
export const relayDemoKey = () => process.env.DI_RELAY_DEMO_KEY ?? 'rly_test_4f7c2a9e1b6d';

const frac = (seed: number, salt: number) => {
  const x = Math.sin(seed * 12.9898 + salt * 78.233) * 43758.5453;
  return x - Math.floor(x);
};

/** The platform's campaigns: every email and digital campaign the institution ran through it, tagged with DI's id. */
export function relayCampaigns() {
  return MODULE_FIXTURES.campaigns
    .filter((c) => c[2] === 'Email' || c[2] === 'Digital')
    .map((c) => {
      const id = c[0] as number;
      const sent = c[4] as number;
      const delivered = Math.round(sent * (0.975 + frac(id, 1) * 0.015));
      const opened = Math.round(delivered * (0.29 + frac(id, 2) * 0.13));
      const clicked = Math.round(delivered * (0.035 + frac(id, 3) * 0.035));
      const unsubscribed = Math.round(delivered * (0.001 + frac(id, 4) * 0.003));
      const launched = String(c[11]);
      return [`rly_cmp_${1000 + id}`, null, c[1], c[2], `DI-CMP-${id}`, 'Sent', sent, delivered, opened, clicked, unsubscribed, null, `${launched} 14:00:00`, `${launched} 18:30:00`];
    });
}

/** DI's API store and the simulated platform, in one tenant schema. Safe to run again. */
export async function createApiTables(admin: mysql.Connection, schema: string) {
  await admin.query(`USE \`${schema}\``);
  for (const ddl of APIS_DDL) await admin.query(ddl);
  await admin.query('DELETE FROM sim_relay_campaign');
  const rows = relayCampaigns();
  if (rows.length) await admin.query('INSERT INTO sim_relay_campaign (campaign_id, list_id, name, channel, tag, status, sent, delivered, opened, clicked, unsubscribed, clicked_refs, sent_at, updated_at) VALUES ?', [rows]);
  for (const table of APIS_WRITE_TABLES) await admin.query(`GRANT INSERT, UPDATE ON \`${schema}\`.\`${table}\` TO 'dinext'@'%'`);
}
