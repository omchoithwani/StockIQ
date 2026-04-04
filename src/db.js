const { createClient } = require('@libsql/client');
require('dotenv').config();

let _db = null;

function getDb() {
  if (!_db) {
    if (!process.env.TURSO_URL) {
      throw new Error('TURSO_URL environment variable is not set');
    }
    _db = createClient({
      url: process.env.TURSO_URL,
      authToken: process.env.TURSO_AUTH_TOKEN,
    });
  }
  return _db;
}

// Proxy so existing code can use `db.execute(...)` unchanged
const db = new Proxy(
  {},
  {
    get(_target, prop) {
      return (...args) => getDb()[prop](...args);
    },
  }
);

async function initSchema() {
  const client = getDb();
  await client.execute(`
    CREATE TABLE IF NOT EXISTS portals (
      portal_id       TEXT PRIMARY KEY,
      access_token    TEXT NOT NULL,
      refresh_token   TEXT NOT NULL,
      token_expires   INTEGER NOT NULL,
      installed_at    INTEGER NOT NULL
    )
  `);
  await client.execute(`
    CREATE TABLE IF NOT EXISTS products (
      id                    TEXT PRIMARY KEY,
      portal_id             TEXT NOT NULL,
      hs_product_id         TEXT NOT NULL,
      sku                   TEXT NOT NULL,
      name                  TEXT NOT NULL,
      quantity              INTEGER NOT NULL DEFAULT 0,
      low_stock_threshold   INTEGER DEFAULT 10,
      is_active             INTEGER DEFAULT 1,
      updated_at            INTEGER NOT NULL,
      FOREIGN KEY (portal_id) REFERENCES portals(portal_id)
    )
  `);
  await client.execute(`
    CREATE TABLE IF NOT EXISTS stock_movements (
      id              TEXT PRIMARY KEY,
      portal_id       TEXT NOT NULL,
      hs_product_id   TEXT NOT NULL,
      sku             TEXT NOT NULL,
      movement_type   TEXT NOT NULL,
      quantity_change INTEGER NOT NULL,
      quantity_after  INTEGER NOT NULL,
      reference       TEXT,
      created_at      INTEGER NOT NULL
    )
  `);
  console.log('[db] Schema initialised');
}

module.exports = { db, initSchema };
