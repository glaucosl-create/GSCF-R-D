import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import pg from 'pg';

const { Pool } = pg;

const defaultCategories = [
  ['Salario', 'income'], ['Freelance', 'income'], ['Rendimentos', 'income'],
  ['Alimentacao', 'expense'], ['Moradia', 'expense'], ['Transporte', 'expense'],
  ['Saude', 'expense'], ['Educacao', 'expense'], ['Lazer', 'expense'],
  ['Assinaturas', 'expense'], ['Cartao de credito', 'expense'], ['Outros', 'expense']
];

function toPostgres(sql) {
  let index = 0;
  return sql.replace(/\?/g, () => `$${++index}`);
}

function sqliteStatement(db, sql) {
  const prepared = db.prepare(sql.sqlite || sql);
  return {
    get: async (...params) => prepared.get(...params),
    all: async (...params) => prepared.all(...params),
    run: async (...params) => {
      const result = prepared.run(...params);
      return { lastInsertRowid: result.lastInsertRowid, changes: result.changes };
    }
  };
}

function postgresStatement(pool, sql) {
  const text = sql.pg || toPostgres(sql.sqlite || sql);
  return {
    get: async (...params) => {
      const result = await pool.query(text, params);
      return result.rows[0] || null;
    },
    all: async (...params) => {
      const result = await pool.query(text, params);
      return result.rows;
    },
    run: async (...params) => {
      const result = await pool.query(text, params);
      return { lastInsertRowid: result.rows[0]?.id, changes: result.rowCount };
    }
  };
}

async function initSqlite(dataDir) {
  const { DatabaseSync } = await import('node:sqlite');
  mkdirSync(dataDir, { recursive: true });
  const db = new DatabaseSync(join(dataDir, 'financeiro.sqlite'));
  db.exec(`
    PRAGMA foreign_keys = ON;
    CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      email TEXT NOT NULL UNIQUE,
      password_hash TEXT NOT NULL,
      email_verified INTEGER NOT NULL DEFAULT 1,
      role TEXT NOT NULL DEFAULT 'user',
      account_status TEXT NOT NULL DEFAULT 'active',
      paid_until TEXT,
      whatsapp_phone TEXT DEFAULT '',
      notify_whatsapp_enabled INTEGER NOT NULL DEFAULT 0,
      notify_sms_enabled INTEGER NOT NULL DEFAULT 0,
      notify_closing_days INTEGER NOT NULL DEFAULT 3,
      notify_due_days INTEGER NOT NULL DEFAULT 3,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE IF NOT EXISTS sessions (
      token TEXT PRIMARY KEY,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      expires_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS email_verifications (
      token TEXT PRIMARY KEY,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      expires_at TEXT NOT NULL,
      used_at TEXT
    );
    CREATE TABLE IF NOT EXISTS license_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      admin_user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
      action TEXT NOT NULL,
      notes TEXT DEFAULT '',
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE IF NOT EXISTS sales_orders (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      provider TEXT NOT NULL,
      external_order_id TEXT,
      buyer_email TEXT,
      buyer_name TEXT,
      status TEXT NOT NULL DEFAULT 'received',
      amount REAL DEFAULT 0,
      raw_payload TEXT NOT NULL,
      processed_at TEXT,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(provider, external_order_id)
    );
    CREATE TABLE IF NOT EXISTS categories (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      name TEXT NOT NULL,
      type TEXT NOT NULL CHECK(type IN ('income','expense')),
      UNIQUE(user_id, name, type)
    );
    CREATE TABLE IF NOT EXISTS cards (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      name TEXT NOT NULL,
      brand TEXT DEFAULT '',
      limit_amount REAL DEFAULT 0,
      closing_day INTEGER DEFAULT 1,
      due_day INTEGER DEFAULT 10,
      active INTEGER DEFAULT 1
    );
    CREATE TABLE IF NOT EXISTS card_reminder_logs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      card_id INTEGER NOT NULL REFERENCES cards(id) ON DELETE CASCADE,
      reminder_type TEXT NOT NULL CHECK(reminder_type IN ('closing','due')),
      reminder_date TEXT NOT NULL,
      target_date TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'sent',
      channel TEXT NOT NULL DEFAULT 'whatsapp',
      message TEXT DEFAULT '',
      provider_response TEXT DEFAULT '',
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(user_id, card_id, reminder_type, reminder_date, target_date)
    );
    CREATE TABLE IF NOT EXISTS invoices (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      card_id INTEGER REFERENCES cards(id) ON DELETE SET NULL,
      month TEXT NOT NULL,
      original_name TEXT NOT NULL,
      stored_name TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'parsed',
      total_amount REAL DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE IF NOT EXISTS transactions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      type TEXT NOT NULL CHECK(type IN ('income','expense')),
      date TEXT NOT NULL,
      description TEXT NOT NULL,
      category TEXT NOT NULL,
      amount REAL NOT NULL,
      payment_method TEXT NOT NULL DEFAULT 'cash',
      card_id INTEGER REFERENCES cards(id) ON DELETE SET NULL,
      invoice_id INTEGER REFERENCES invoices(id) ON DELETE SET NULL,
      reference_month TEXT,
      installment_group TEXT,
      installment_index INTEGER DEFAULT 1,
      installment_total INTEGER DEFAULT 1,
      notes TEXT DEFAULT '',
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE IF NOT EXISTS investment_assets (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      ticker TEXT NOT NULL,
      name TEXT NOT NULL,
      asset_type TEXT NOT NULL DEFAULT 'outros',
      institution TEXT DEFAULT '',
      current_price REAL DEFAULT 0,
      target_percent REAL DEFAULT 0,
      notes TEXT DEFAULT '',
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(user_id, ticker)
    );
    CREATE TABLE IF NOT EXISTS investment_movements (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      asset_id INTEGER NOT NULL REFERENCES investment_assets(id) ON DELETE CASCADE,
      date TEXT NOT NULL,
      kind TEXT NOT NULL CHECK(kind IN ('buy','sell','dividend','interest','fee')),
      quantity REAL DEFAULT 0,
      unit_price REAL DEFAULT 0,
      amount REAL NOT NULL DEFAULT 0,
      fees REAL DEFAULT 0,
      notes TEXT DEFAULT '',
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
    CREATE INDEX IF NOT EXISTS idx_sessions_expires ON sessions(expires_at);
    CREATE INDEX IF NOT EXISTS idx_invoices_user_month ON invoices(user_id, month);
    CREATE INDEX IF NOT EXISTS idx_transactions_user_date ON transactions(user_id, date);
    CREATE INDEX IF NOT EXISTS idx_transactions_user_group ON transactions(user_id, installment_group);
    CREATE INDEX IF NOT EXISTS idx_transactions_user_invoice ON transactions(user_id, invoice_id);
    CREATE INDEX IF NOT EXISTS idx_card_reminder_logs_user_date ON card_reminder_logs(user_id, reminder_date);
    CREATE INDEX IF NOT EXISTS idx_investment_assets_user ON investment_assets(user_id, asset_type, ticker);
    CREATE INDEX IF NOT EXISTS idx_investment_movements_user_date ON investment_movements(user_id, date);
    CREATE INDEX IF NOT EXISTS idx_investment_movements_asset ON investment_movements(asset_id, date);
  `);

  const userColumns = db.prepare('PRAGMA table_info(users)').all().map(column => column.name);
  if (!userColumns.includes('email_verified')) db.exec('ALTER TABLE users ADD COLUMN email_verified INTEGER NOT NULL DEFAULT 1');
  if (!userColumns.includes('role')) db.exec("ALTER TABLE users ADD COLUMN role TEXT NOT NULL DEFAULT 'user'");
  if (!userColumns.includes('account_status')) db.exec("ALTER TABLE users ADD COLUMN account_status TEXT NOT NULL DEFAULT 'active'");
  if (!userColumns.includes('paid_until')) db.exec('ALTER TABLE users ADD COLUMN paid_until TEXT');
  if (!userColumns.includes('whatsapp_phone')) db.exec("ALTER TABLE users ADD COLUMN whatsapp_phone TEXT DEFAULT ''");
  if (!userColumns.includes('notify_whatsapp_enabled')) db.exec('ALTER TABLE users ADD COLUMN notify_whatsapp_enabled INTEGER NOT NULL DEFAULT 0');
  if (!userColumns.includes('notify_sms_enabled')) db.exec('ALTER TABLE users ADD COLUMN notify_sms_enabled INTEGER NOT NULL DEFAULT 0');
  if (!userColumns.includes('notify_closing_days')) db.exec('ALTER TABLE users ADD COLUMN notify_closing_days INTEGER NOT NULL DEFAULT 3');
  if (!userColumns.includes('notify_due_days')) db.exec('ALTER TABLE users ADD COLUMN notify_due_days INTEGER NOT NULL DEFAULT 3');
  const transactionColumns = db.prepare('PRAGMA table_info(transactions)').all().map(column => column.name);
  if (!transactionColumns.includes('reference_month')) db.exec('ALTER TABLE transactions ADD COLUMN reference_month TEXT');
  db.exec('CREATE INDEX IF NOT EXISTS idx_transactions_user_reference_month ON transactions(user_id, reference_month)');
  db.exec("UPDATE users SET role = 'admin' WHERE lower(email) = lower('glaucosl@gmail.com')");
  db.exec("UPDATE users SET role = 'admin' WHERE id = (SELECT id FROM users ORDER BY id LIMIT 1) AND NOT EXISTS (SELECT 1 FROM users WHERE role = 'admin')");
  return { kind: 'sqlite', prepare: (sql) => sqliteStatement(db, sql), close: () => db.close?.() };
}

async function initPostgres() {
  const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: process.env.PGSSLMODE === 'disable' ? false : { rejectUnauthorized: false }
  });
  await pool.query(`
    CREATE TABLE IF NOT EXISTS users (
      id SERIAL PRIMARY KEY,
      email TEXT NOT NULL UNIQUE,
      password_hash TEXT NOT NULL,
      email_verified INTEGER NOT NULL DEFAULT 1,
      role TEXT NOT NULL DEFAULT 'user',
      account_status TEXT NOT NULL DEFAULT 'active',
      paid_until TEXT,
      whatsapp_phone TEXT DEFAULT '',
      notify_whatsapp_enabled INTEGER NOT NULL DEFAULT 0,
      notify_sms_enabled INTEGER NOT NULL DEFAULT 0,
      notify_closing_days INTEGER NOT NULL DEFAULT 3,
      notify_due_days INTEGER NOT NULL DEFAULT 3,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE IF NOT EXISTS sessions (
      token TEXT PRIMARY KEY,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      expires_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS email_verifications (
      token TEXT PRIMARY KEY,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      expires_at TEXT NOT NULL,
      used_at TEXT
    );
    CREATE TABLE IF NOT EXISTS license_events (
      id SERIAL PRIMARY KEY,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      admin_user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
      action TEXT NOT NULL,
      notes TEXT DEFAULT '',
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE IF NOT EXISTS sales_orders (
      id SERIAL PRIMARY KEY,
      provider TEXT NOT NULL,
      external_order_id TEXT,
      buyer_email TEXT,
      buyer_name TEXT,
      status TEXT NOT NULL DEFAULT 'received',
      amount REAL DEFAULT 0,
      raw_payload TEXT NOT NULL,
      processed_at TEXT,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(provider, external_order_id)
    );
    CREATE TABLE IF NOT EXISTS categories (
      id SERIAL PRIMARY KEY,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      name TEXT NOT NULL,
      type TEXT NOT NULL CHECK(type IN ('income','expense')),
      UNIQUE(user_id, name, type)
    );
    CREATE TABLE IF NOT EXISTS cards (
      id SERIAL PRIMARY KEY,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      name TEXT NOT NULL,
      brand TEXT DEFAULT '',
      limit_amount REAL DEFAULT 0,
      closing_day INTEGER DEFAULT 1,
      due_day INTEGER DEFAULT 10,
      active INTEGER DEFAULT 1
    );
    CREATE TABLE IF NOT EXISTS card_reminder_logs (
      id SERIAL PRIMARY KEY,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      card_id INTEGER NOT NULL REFERENCES cards(id) ON DELETE CASCADE,
      reminder_type TEXT NOT NULL CHECK(reminder_type IN ('closing','due')),
      reminder_date TEXT NOT NULL,
      target_date TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'sent',
      channel TEXT NOT NULL DEFAULT 'whatsapp',
      message TEXT DEFAULT '',
      provider_response TEXT DEFAULT '',
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(user_id, card_id, reminder_type, reminder_date, target_date)
    );
    CREATE TABLE IF NOT EXISTS invoices (
      id SERIAL PRIMARY KEY,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      card_id INTEGER REFERENCES cards(id) ON DELETE SET NULL,
      month TEXT NOT NULL,
      original_name TEXT NOT NULL,
      stored_name TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'parsed',
      total_amount REAL DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE IF NOT EXISTS transactions (
      id SERIAL PRIMARY KEY,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      type TEXT NOT NULL CHECK(type IN ('income','expense')),
      date TEXT NOT NULL,
      description TEXT NOT NULL,
      category TEXT NOT NULL,
      amount REAL NOT NULL,
      payment_method TEXT NOT NULL DEFAULT 'cash',
      card_id INTEGER REFERENCES cards(id) ON DELETE SET NULL,
      invoice_id INTEGER REFERENCES invoices(id) ON DELETE SET NULL,
      reference_month TEXT,
      installment_group TEXT,
      installment_index INTEGER DEFAULT 1,
      installment_total INTEGER DEFAULT 1,
      notes TEXT DEFAULT '',
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE IF NOT EXISTS investment_assets (
      id SERIAL PRIMARY KEY,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      ticker TEXT NOT NULL,
      name TEXT NOT NULL,
      asset_type TEXT NOT NULL DEFAULT 'outros',
      institution TEXT DEFAULT '',
      current_price REAL DEFAULT 0,
      target_percent REAL DEFAULT 0,
      notes TEXT DEFAULT '',
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(user_id, ticker)
    );
    CREATE TABLE IF NOT EXISTS investment_movements (
      id SERIAL PRIMARY KEY,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      asset_id INTEGER NOT NULL REFERENCES investment_assets(id) ON DELETE CASCADE,
      date TEXT NOT NULL,
      kind TEXT NOT NULL CHECK(kind IN ('buy','sell','dividend','interest','fee')),
      quantity REAL DEFAULT 0,
      unit_price REAL DEFAULT 0,
      amount REAL NOT NULL DEFAULT 0,
      fees REAL DEFAULT 0,
      notes TEXT DEFAULT '',
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
    CREATE INDEX IF NOT EXISTS idx_sessions_expires ON sessions(expires_at);
    CREATE INDEX IF NOT EXISTS idx_invoices_user_month ON invoices(user_id, month);
    CREATE INDEX IF NOT EXISTS idx_transactions_user_date ON transactions(user_id, date);
    CREATE INDEX IF NOT EXISTS idx_transactions_user_group ON transactions(user_id, installment_group);
    CREATE INDEX IF NOT EXISTS idx_transactions_user_invoice ON transactions(user_id, invoice_id);
    CREATE INDEX IF NOT EXISTS idx_card_reminder_logs_user_date ON card_reminder_logs(user_id, reminder_date);
    CREATE INDEX IF NOT EXISTS idx_investment_assets_user ON investment_assets(user_id, asset_type, ticker);
    CREATE INDEX IF NOT EXISTS idx_investment_movements_user_date ON investment_movements(user_id, date);
    CREATE INDEX IF NOT EXISTS idx_investment_movements_asset ON investment_movements(asset_id, date);
    ALTER TABLE users ADD COLUMN IF NOT EXISTS email_verified INTEGER NOT NULL DEFAULT 1;
    ALTER TABLE users ADD COLUMN IF NOT EXISTS role TEXT NOT NULL DEFAULT 'user';
    ALTER TABLE users ADD COLUMN IF NOT EXISTS account_status TEXT NOT NULL DEFAULT 'active';
    ALTER TABLE users ADD COLUMN IF NOT EXISTS paid_until TEXT;
    ALTER TABLE users ADD COLUMN IF NOT EXISTS whatsapp_phone TEXT DEFAULT '';
    ALTER TABLE users ADD COLUMN IF NOT EXISTS notify_whatsapp_enabled INTEGER NOT NULL DEFAULT 0;
    ALTER TABLE users ADD COLUMN IF NOT EXISTS notify_sms_enabled INTEGER NOT NULL DEFAULT 0;
    ALTER TABLE users ADD COLUMN IF NOT EXISTS notify_closing_days INTEGER NOT NULL DEFAULT 3;
    ALTER TABLE users ADD COLUMN IF NOT EXISTS notify_due_days INTEGER NOT NULL DEFAULT 3;
    ALTER TABLE transactions ADD COLUMN IF NOT EXISTS reference_month TEXT;
    CREATE INDEX IF NOT EXISTS idx_transactions_user_reference_month ON transactions(user_id, reference_month);
    UPDATE users SET role = 'admin' WHERE lower(email) = lower('glaucosl@gmail.com');
    UPDATE users SET role = 'admin'
      WHERE id = (SELECT id FROM users ORDER BY id LIMIT 1)
      AND NOT EXISTS (SELECT 1 FROM users WHERE role = 'admin');
  `);
  return { kind: 'postgres', prepare: (sql) => postgresStatement(pool, sql), close: () => pool.end() };
}

export async function initDatabase({ dataDir }) {
  const adapter = process.env.DATABASE_URL ? await initPostgres() : await initSqlite(dataDir);
  const prepare = adapter.prepare;
  const statements = {
    createUser: prepare({
      sqlite: 'INSERT INTO users (email, password_hash) VALUES (?, ?)',
      pg: 'INSERT INTO users (email, password_hash) VALUES ($1, $2) RETURNING id'
    }),
    createUnverifiedUser: prepare({
      sqlite: "INSERT INTO users (email, password_hash, email_verified, account_status) VALUES (?, ?, 0, 'pending_payment')",
      pg: "INSERT INTO users (email, password_hash, email_verified, account_status) VALUES ($1, $2, 0, 'pending_payment') RETURNING id"
    }),
    getUserByEmail: prepare('SELECT * FROM users WHERE email = ?'),
    getUserById: prepare('SELECT id, email, email_verified, role, account_status, paid_until, whatsapp_phone, notify_whatsapp_enabled, notify_sms_enabled, notify_closing_days, notify_due_days, created_at FROM users WHERE id = ?'),
    getPrivateUserById: prepare('SELECT * FROM users WHERE id = ?'),
    verifyUserEmail: prepare('UPDATE users SET email_verified = 1 WHERE id = ?'),
    updatePassword: prepare('UPDATE users SET password_hash = ? WHERE id = ?'),
    updateNotificationSettings: prepare('UPDATE users SET whatsapp_phone = ?, notify_whatsapp_enabled = ?, notify_sms_enabled = ?, notify_closing_days = ?, notify_due_days = ? WHERE id = ?'),
    createSession: prepare('INSERT INTO sessions (token, user_id, expires_at) VALUES (?, ?, ?)'),
    getSession: prepare({
      sqlite: 'SELECT * FROM sessions WHERE token = ? AND expires_at > CURRENT_TIMESTAMP',
      pg: 'SELECT * FROM sessions WHERE token = $1 AND expires_at::timestamptz > CURRENT_TIMESTAMP'
    }),
    deleteSession: prepare('DELETE FROM sessions WHERE token = ?'),
    createVerification: prepare('INSERT INTO email_verifications (token, user_id, expires_at) VALUES (?, ?, ?)'),
    getVerification: prepare({
      sqlite: 'SELECT * FROM email_verifications WHERE token = ? AND used_at IS NULL AND expires_at > CURRENT_TIMESTAMP',
      pg: 'SELECT * FROM email_verifications WHERE token = $1 AND used_at IS NULL AND expires_at::timestamptz > CURRENT_TIMESTAMP'
    }),
    useVerification: prepare('UPDATE email_verifications SET used_at = CURRENT_TIMESTAMP WHERE token = ?'),
    listAdminUsers: prepare('SELECT id, email, email_verified, role, account_status, paid_until, whatsapp_phone, notify_whatsapp_enabled, notify_sms_enabled, notify_closing_days, notify_due_days, created_at FROM users ORDER BY created_at DESC, id DESC'),
    updateUserAccess: prepare('UPDATE users SET account_status = ?, paid_until = ?, role = ? WHERE id = ?'),
    addLicenseEvent: prepare('INSERT INTO license_events (user_id, admin_user_id, action, notes) VALUES (?, ?, ?, ?)'),
    listSalesOrders: prepare('SELECT * FROM sales_orders ORDER BY created_at DESC, id DESC LIMIT 100'),
    insertSalesOrder: prepare({
      sqlite: `INSERT INTO sales_orders
        (provider, external_order_id, buyer_email, buyer_name, status, amount, raw_payload)
        VALUES (?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(provider, external_order_id) DO UPDATE SET
          buyer_email=excluded.buyer_email,
          buyer_name=excluded.buyer_name,
          status=excluded.status,
          amount=excluded.amount,
          raw_payload=excluded.raw_payload`,
      pg: `INSERT INTO sales_orders
        (provider, external_order_id, buyer_email, buyer_name, status, amount, raw_payload)
        VALUES ($1, $2, $3, $4, $5, $6, $7)
        ON CONFLICT(provider, external_order_id) DO UPDATE SET
          buyer_email=excluded.buyer_email,
          buyer_name=excluded.buyer_name,
          status=excluded.status,
          amount=excluded.amount,
          raw_payload=excluded.raw_payload`
    }),
    addCategory: prepare({
      sqlite: 'INSERT OR IGNORE INTO categories (user_id, name, type) VALUES (?, ?, ?)',
      pg: 'INSERT INTO categories (user_id, name, type) VALUES ($1, $2, $3) ON CONFLICT(user_id, name, type) DO NOTHING'
    }),
    listCategories: prepare('SELECT * FROM categories WHERE user_id = ? ORDER BY type, name'),
    getCategory: prepare('SELECT * FROM categories WHERE id = ? AND user_id = ?'),
    insertCategory: prepare({
      sqlite: 'INSERT INTO categories (user_id, name, type) VALUES (?, ?, ?)',
      pg: 'INSERT INTO categories (user_id, name, type) VALUES ($1, $2, $3) RETURNING id'
    }),
    updateCategory: prepare('UPDATE categories SET name = ?, type = ? WHERE id = ? AND user_id = ?'),
    deleteCategory: prepare('DELETE FROM categories WHERE id = ? AND user_id = ?'),
    updateTransactionCategoryName: prepare('UPDATE transactions SET category = ? WHERE user_id = ? AND category = ? AND type = ?'),
    listCards: prepare('SELECT * FROM cards WHERE user_id = ? ORDER BY active DESC, name'),
    getCard: prepare('SELECT * FROM cards WHERE id = ? AND user_id = ?'),
    insertCard: prepare({
      sqlite: 'INSERT INTO cards (user_id, name, brand, limit_amount, closing_day, due_day, active) VALUES (?, ?, ?, ?, ?, ?, ?)',
      pg: 'INSERT INTO cards (user_id, name, brand, limit_amount, closing_day, due_day, active) VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id'
    }),
    updateCard: prepare('UPDATE cards SET name=?, brand=?, limit_amount=?, closing_day=?, due_day=?, active=? WHERE id=? AND user_id=?'),
    deleteCard: prepare('DELETE FROM cards WHERE id=? AND user_id=?'),
    listCardReminderTargets: prepare(`
      SELECT
        u.id AS user_id,
        u.email,
        u.whatsapp_phone,
        u.notify_whatsapp_enabled,
        u.notify_sms_enabled,
        u.notify_closing_days,
        u.notify_due_days,
        u.paid_until,
        c.id AS card_id,
        c.name AS card_name,
        c.brand,
        c.closing_day,
        c.due_day
      FROM users u
      JOIN cards c ON c.user_id = u.id
      WHERE (u.notify_whatsapp_enabled = 1 OR u.notify_sms_enabled = 1)
        AND COALESCE(u.whatsapp_phone, '') <> ''
        AND u.account_status = 'active'
        AND c.active = 1
      ORDER BY u.id, c.name
    `),
    getCardReminderLog: prepare(`SELECT * FROM card_reminder_logs WHERE user_id = ? AND card_id = ? AND reminder_type = ? AND reminder_date = ? AND target_date = ?`),
    upsertCardReminderLog: prepare(`
      INSERT INTO card_reminder_logs
        (user_id, card_id, reminder_type, reminder_date, target_date, status, channel, message, provider_response)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(user_id, card_id, reminder_type, reminder_date, target_date) DO UPDATE SET
        status = excluded.status,
        message = excluded.message,
        provider_response = excluded.provider_response,
        created_at = CURRENT_TIMESTAMP
    `),
    listTransactions: prepare(`
      SELECT
        t.*,
        c.name AS card_name,
        i.month AS invoice_month
      FROM transactions t
      LEFT JOIN cards c ON c.id=t.card_id AND c.user_id=t.user_id
      LEFT JOIN invoices i ON i.id=t.invoice_id AND i.user_id=t.user_id
      WHERE t.user_id=?
      ORDER BY t.date DESC, t.id DESC
    `),
    getTransaction: prepare('SELECT * FROM transactions WHERE id = ? AND user_id = ?'),
    insertTransaction: prepare({
      sqlite: `INSERT INTO transactions
        (user_id, type, date, description, category, amount, payment_method, card_id, invoice_id, reference_month, installment_group, installment_index, installment_total, notes)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      pg: `INSERT INTO transactions
        (user_id, type, date, description, category, amount, payment_method, card_id, invoice_id, reference_month, installment_group, installment_index, installment_total, notes)
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)`
    }),
    updateTransaction: prepare(`UPDATE transactions SET type=?, date=?, description=?, category=?, amount=?, payment_method=?, card_id=?, invoice_id=?, reference_month=?, installment_group=?, installment_index=?, installment_total=?, notes=? WHERE id=? AND user_id=?`),
    deleteTransaction: prepare('DELETE FROM transactions WHERE id=? AND user_id=?'),
    listInstallmentGroup: prepare('SELECT * FROM transactions WHERE user_id = ? AND installment_group = ? ORDER BY installment_index, id'),
    deleteTransactionGroupAfter: prepare('DELETE FROM transactions WHERE user_id = ? AND installment_group = ? AND installment_index > ?'),
    deleteTransactionGroupExcept: prepare('DELETE FROM transactions WHERE user_id = ? AND installment_group = ? AND id <> ?'),
    listInvestmentAssets: prepare('SELECT * FROM investment_assets WHERE user_id = ? ORDER BY asset_type, ticker'),
    getInvestmentAsset: prepare('SELECT * FROM investment_assets WHERE id = ? AND user_id = ?'),
    insertInvestmentAsset: prepare({
      sqlite: `INSERT INTO investment_assets
        (user_id, ticker, name, asset_type, institution, current_price, target_percent, notes)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      pg: `INSERT INTO investment_assets
        (user_id, ticker, name, asset_type, institution, current_price, target_percent, notes)
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING id`
    }),
    updateInvestmentAsset: prepare(`UPDATE investment_assets SET ticker=?, name=?, asset_type=?, institution=?, current_price=?, target_percent=?, notes=? WHERE id=? AND user_id=?`),
    deleteInvestmentAsset: prepare('DELETE FROM investment_assets WHERE id=? AND user_id=?'),
    listInvestmentMovements: prepare(`
      SELECT m.*, a.ticker, a.name AS asset_name, a.asset_type
      FROM investment_movements m
      JOIN investment_assets a ON a.id = m.asset_id AND a.user_id = m.user_id
      WHERE m.user_id = ?
      ORDER BY m.date DESC, m.id DESC
    `),
    getInvestmentMovement: prepare('SELECT * FROM investment_movements WHERE id = ? AND user_id = ?'),
    insertInvestmentMovement: prepare({
      sqlite: `INSERT INTO investment_movements
        (user_id, asset_id, date, kind, quantity, unit_price, amount, fees, notes)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      pg: `INSERT INTO investment_movements
        (user_id, asset_id, date, kind, quantity, unit_price, amount, fees, notes)
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) RETURNING id`
    }),
    updateInvestmentMovement: prepare(`UPDATE investment_movements SET asset_id=?, date=?, kind=?, quantity=?, unit_price=?, amount=?, fees=?, notes=? WHERE id=? AND user_id=?`),
    deleteInvestmentMovement: prepare('DELETE FROM investment_movements WHERE id=? AND user_id=?'),
    findProjectedInstallment: prepare({
      sqlite: `
        SELECT *
        FROM transactions
        WHERE user_id = ?
          AND invoice_id IS NULL
          AND payment_method = 'credit_card'
          AND type = ?
          AND (card_id = ? OR (card_id IS NULL AND ? IS NULL))
          AND installment_index = ?
          AND installment_total = ?
          AND ABS(amount - ?) < 0.011
          AND lower(trim(description)) = lower(trim(?))
        ORDER BY id
        LIMIT 1
      `,
      pg: `
        SELECT *
        FROM transactions
        WHERE user_id = $1
          AND invoice_id IS NULL
          AND payment_method = 'credit_card'
          AND type = $2
          AND (card_id = $3 OR (card_id IS NULL AND $4::integer IS NULL))
          AND installment_index = $5
          AND installment_total = $6
          AND ABS(amount - $7) < 0.011
          AND lower(trim(description)) = lower(trim($8))
        ORDER BY id
        LIMIT 1
      `
    }),
    findProjectedInstallmentByGroup: prepare(`
      SELECT *
      FROM transactions
      WHERE user_id = ?
        AND invoice_id IS NULL
        AND installment_group = ?
        AND installment_index = ?
      ORDER BY id
      LIMIT 1
    `),
    insertInvoice: prepare({
      sqlite: 'INSERT INTO invoices (user_id, card_id, month, original_name, stored_name, total_amount) VALUES (?, ?, ?, ?, ?, ?)',
      pg: 'INSERT INTO invoices (user_id, card_id, month, original_name, stored_name, total_amount) VALUES ($1, $2, $3, $4, $5, $6) RETURNING id'
    }),
    updateInvoiceTotal: prepare('UPDATE invoices SET total_amount = ? WHERE id = ? AND user_id = ?'),
    findInvoiceByUpload: prepare({
      sqlite: 'SELECT * FROM invoices WHERE user_id = ? AND month = ? AND original_name = ? AND (card_id = ? OR (card_id IS NULL AND ? IS NULL)) LIMIT 1',
      pg: 'SELECT * FROM invoices WHERE user_id = $1 AND month = $2 AND original_name = $3 AND (card_id = $4 OR (card_id IS NULL AND $5::integer IS NULL)) LIMIT 1'
    }),
    listInvoices: prepare('SELECT i.*, c.name AS card_name FROM invoices i LEFT JOIN cards c ON c.id=i.card_id AND c.user_id=i.user_id WHERE i.user_id=? ORDER BY i.month DESC, i.id DESC'),
    getInvoice: prepare('SELECT * FROM invoices WHERE id = ? AND user_id = ?'),
    countInvoiceTransactions: prepare('SELECT COUNT(*) AS count FROM transactions WHERE user_id = ? AND invoice_id = ?'),
    deleteInvoiceTransactions: prepare('DELETE FROM transactions WHERE user_id = ? AND invoice_id = ?'),
    deleteInvoiceProjectedTransactions: prepare(`DELETE FROM transactions
      WHERE user_id = ?
        AND invoice_id IS NULL
        AND installment_group IN (
          SELECT installment_group
          FROM transactions
          WHERE user_id = ? AND invoice_id = ? AND installment_group IS NOT NULL
        )`),
    deleteInvoice: prepare('DELETE FROM invoices WHERE id = ? AND user_id = ?')
  };
  return { ...adapter, defaultCategories, statements };
}
