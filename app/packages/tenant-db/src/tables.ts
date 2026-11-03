// Saved views and snapshots in the Tables app (spec 8.11). Each one is made, shared, deleted or
// restored only through an approved DI Core operation; approval_id makes each make run once. A view
// keeps its definition, never a copy of rows. A snapshot keeps its frozen rows as JSON, capped at
// 5,000. A delete moves it to the Recycle Bin, never out of the table. The seeded view is a demo value.
export const TABLES_DDL = [
  `CREATE TABLE tbl_object (
     obj_id INT AUTO_INCREMENT PRIMARY KEY,
     kind VARCHAR(12) NOT NULL,
     name VARCHAR(120) NOT NULL,
     table_id VARCHAR(40) NOT NULL,
     definition JSON NULL,
     content LONGTEXT NULL,
     row_count INT NOT NULL,
     owner_user_id VARCHAR(40) NOT NULL,
     owner_name VARCHAR(80) NOT NULL,
     shared_class VARCHAR(30) NULL,
     status VARCHAR(12) NOT NULL,
     created_on DATE NOT NULL,
     recycled_on DATE NULL,
     approval_id VARCHAR(40) NULL UNIQUE,
     KEY ix_obj_owner (owner_user_id, status),
     KEY ix_obj_table (table_id, status)
   )`,
];

export const TABLES_WRITE_TABLES = ['tbl_object'];

interface Conn {
  query(sql: string, params?: unknown[]): Promise<unknown>;
}

/** One saved view, Priya Shah's, so the list isn't empty on a fresh seed. A view's rows are counted each time it's opened. */
export async function seedTables(db: Conn, ignore = false) {
  const insert = ignore ? 'INSERT IGNORE' : 'INSERT';
  await db.query(`${insert} INTO tbl_object (obj_id, kind, name, table_id, definition, row_count, owner_user_id, owner_name, shared_class, status, created_on) VALUES ?`, [[[1, 'View', 'Loans with member details', 'loan_accounts', JSON.stringify({ left: 'loan_accounts', right: 'members', key: 'member_id' }), 0, 'user:4410', 'Priya Shah', null, 'Active', '2026-10-21']]]);
}
