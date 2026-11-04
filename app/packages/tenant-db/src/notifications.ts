// Email notifications (today's DI: new COMs, COM follow-ups, the COM inbox each morning, report
// schedule deliveries). There is no mail service in this demo, so DI writes each email to a simulated
// outbox instead of sending it. Each person chooses which kinds they get.
export const NOTIFY_DDL = [
  `CREATE TABLE ntf_email (
     email_id INT AUTO_INCREMENT PRIMARY KEY,
     user_id VARCHAR(40) NOT NULL,
     to_name VARCHAR(80) NOT NULL,
     to_address VARCHAR(160) NOT NULL,
     subject VARCHAR(200) NOT NULL,
     body TEXT NOT NULL,
     link VARCHAR(300) NOT NULL,
     kind VARCHAR(24) NOT NULL,
     source_ref VARCHAR(160) NOT NULL,
     status VARCHAR(20) NOT NULL,
     created_at DATETIME(3) NOT NULL,
     sent_at DATETIME(3) NULL,
     UNIQUE KEY ux_email_source (user_id, source_ref),
     KEY ix_email_user (user_id, created_at),
     KEY ix_email_kind (kind)
   )`,
  // No row means the default for that kind.
  `CREATE TABLE ntf_pref (
     user_id VARCHAR(40) NOT NULL,
     kind VARCHAR(24) NOT NULL,
     enabled TINYINT NOT NULL,
     approval_id VARCHAR(40) NULL,
     updated_at DATETIME(3) NOT NULL,
     PRIMARY KEY (user_id, kind)
   )`,
];

export const NOTIFY_WRITE_TABLES = ['ntf_email', 'ntf_pref'];
