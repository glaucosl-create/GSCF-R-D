import { DatabaseSync } from 'node:sqlite';
import pg from 'pg';

const { Pool } = pg;
const sqlitePath = process.argv[2] || 'data/financeiro.sqlite';

if (!process.env.DATABASE_URL) {
  console.error('Defina DATABASE_URL antes de rodar a migracao.');
  process.exit(1);
}

const sqlite = new DatabaseSync(sqlitePath);
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.PGSSLMODE === 'disable' ? false : { rejectUnauthorized: false }
});

const tables = [
  'users',
  'categories',
  'cards',
  'invoices',
  'transactions',
  'email_verifications',
  'sessions',
  'license_events',
  'sales_orders'
];

const columnNames = (table) => sqlite.prepare(`PRAGMA table_info(${table})`).all().map(column => column.name);
const rowsFor = (table) => sqlite.prepare(`SELECT * FROM ${table}`).all();

try {
  await pool.query('BEGIN');
  for (const table of tables) {
    const columns = columnNames(table);
    const rows = rowsFor(table);
    if (!rows.length) continue;
    const names = columns.map(name => `"${name}"`).join(', ');
    const placeholders = columns.map((_, index) => `$${index + 1}`).join(', ');
    const updates = columns
      .filter(name => name !== 'id' && name !== 'token')
      .map(name => `"${name}" = EXCLUDED."${name}"`)
      .join(', ');
    const conflict = table === 'sessions' || table === 'email_verifications'
      ? 'token'
      : table === 'sales_orders'
        ? 'provider, external_order_id'
        : 'id';
    const conflictSql = updates ? `ON CONFLICT (${conflict}) DO UPDATE SET ${updates}` : `ON CONFLICT (${conflict}) DO NOTHING`;
    for (const row of rows) {
      await pool.query(
        `INSERT INTO ${table} (${names}) VALUES (${placeholders}) ${conflictSql}`,
        columns.map(column => row[column])
      );
    }
    if (columns.includes('id')) {
      await pool.query(`SELECT setval(pg_get_serial_sequence('${table}', 'id'), COALESCE((SELECT MAX(id) FROM ${table}), 1), true)`);
    }
    console.log(`${table}: ${rows.length} registros migrados`);
  }
  await pool.query('COMMIT');
  console.log('Migracao concluida.');
} catch (error) {
  await pool.query('ROLLBACK');
  console.error(error);
  process.exitCode = 1;
} finally {
  await pool.end();
  sqlite.close();
}
