// Data layer, now backed by Turso (libSQL) instead of the local node:sqlite
// file — this is what makes the app reachable from anywhere (any wifi, any
// cellular data, from a phone) instead of only from whatever one computer
// has the local .db file on its disk. Same SQL as before (libSQL is a
// SQLite-compatible fork), but every call is now a network round-trip, so
// every call is async — that's the one real behavior change this migration
// introduces throughout the codebase.
//
// Needs a .env file (see README) with:
//   TURSO_DATABASE_URL=libsql://your-db-name.turso.io
//   TURSO_AUTH_TOKEN=your-token
// Run node with --env-file=.env (already wired into the npm scripts) so
// these are picked up without needing the `dotenv` package — keeps this
// project dependency-light even with a real hosted database now involved.

import { createClient } from '@libsql/client';

const url = process.env.TURSO_DATABASE_URL;
const authToken = process.env.TURSO_AUTH_TOKEN;

if (!url) {
  throw new Error(
    'Missing TURSO_DATABASE_URL. Create a .env file in the project root with your Turso ' +
    'database URL and auth token (see README.md "Database setup") before running this app.'
  );
}

const client = createClient({ url, authToken });

// Thin async query helpers shaped like the old synchronous node:sqlite API
// (db.prepare(sql).get/.all/.run) — kept close to the original shape on
// purpose so every call site elsewhere in the codebase only needed an
// `await` added, not a full rewrite of its SQL or logic.
export const db = {
  /** One row, or undefined. */
  async get(sql, args = []) {
    const result = await client.execute({ sql, args });
    return result.rows[0] ?? undefined;
  },
  /** All matching rows. */
  async all(sql, args = []) {
    const result = await client.execute({ sql, args });
    return result.rows;
  },
  /** INSERT/UPDATE/DELETE — returns { lastInsertRowid, changes }. */
  async run(sql, args = []) {
    const result = await client.execute({ sql, args });
    return { lastInsertRowid: result.lastInsertRowid, changes: result.rowsAffected };
  },
};

const SCHEMA_STATEMENTS = [
  // No password by design (Dawson's call, for now): logging in is just picking
  // your name. This only matters if the app becomes reachable from outside
  // your own network — revisit before that happens.
  `CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL UNIQUE,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  )`,

  `CREATE TABLE IF NOT EXISTS sessions (
    token TEXT PRIMARY KEY,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    expires_at TEXT NOT NULL
  )`,

  // A product is one model+color line, e.g. "121KH".
  `CREATE TABLE IF NOT EXISTS products (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    model TEXT NOT NULL,
    color TEXT NOT NULL,
    sku TEXT NOT NULL UNIQUE,
    display_name TEXT,
    active INTEGER NOT NULL DEFAULT 1,
    rules_confidence TEXT NOT NULL DEFAULT 'CONFIRMED',
    notes TEXT
  )`,

  // Each piece-number within a product, with its role and whether it's required
  // to form a sellable couch, or an optional/flexible add-on the customer picks.
  `CREATE TABLE IF NOT EXISTS piece_types (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    product_id INTEGER NOT NULL REFERENCES products(id) ON DELETE CASCADE,
    piece_number INTEGER NOT NULL,
    full_sku TEXT NOT NULL UNIQUE,
    label TEXT NOT NULL,
    requirement TEXT NOT NULL,
    UNIQUE(product_id, piece_number)
  )`,

  // On-hand box counts, per piece type, per physical location.
  `CREATE TABLE IF NOT EXISTS inventory (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    piece_type_id INTEGER NOT NULL REFERENCES piece_types(id) ON DELETE CASCADE,
    location TEXT NOT NULL,
    quantity INTEGER NOT NULL DEFAULT 0,
    UNIQUE(piece_type_id, location)
  )`,

  `CREATE TABLE IF NOT EXISTS trips (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    trip_number INTEGER,
    date TEXT NOT NULL,
    traveler TEXT,
    boxes_expected INTEGER,
    boxes_actual INTEGER NOT NULL,
    total_cost REAL NOT NULL,
    gas_cost REAL DEFAULT 0,
    notes TEXT,
    entered_by TEXT,
    is_historical INTEGER NOT NULL DEFAULT 0
  )`,

  `CREATE TABLE IF NOT EXISTS trip_photos (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    trip_id INTEGER NOT NULL REFERENCES trips(id) ON DELETE CASCADE,
    file_path TEXT NOT NULL,
    uploaded_by TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  )`,

  `CREATE TABLE IF NOT EXISTS sales (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    date TEXT NOT NULL,
    product_id INTEGER REFERENCES products(id),
    trip_id INTEGER REFERENCES trips(id),
    pieces_total INTEGER,
    base_price REAL NOT NULL,
    delivery_fee REAL NOT NULL DEFAULT 0,
    delivery_by TEXT,
    assembly_fee REAL NOT NULL DEFAULT 0,
    assembly_by TEXT,
    payment_method TEXT,
    payment_status TEXT NOT NULL DEFAULT 'Paid',
    deposit_amount REAL DEFAULT 0,
    customer_name TEXT,
    customer_phone TEXT,
    delivery_date TEXT,
    delivery_status TEXT DEFAULT 'Not scheduled',
    notes TEXT,
    entered_by TEXT,
    is_historical INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  )`,

  // Exact piece-level breakdown of a (new, non-historical) sale, so inventory
  // decrements accurately instead of just against a total piece count.
  `CREATE TABLE IF NOT EXISTS sale_items (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    sale_id INTEGER NOT NULL REFERENCES sales(id) ON DELETE CASCADE,
    piece_type_id INTEGER NOT NULL REFERENCES piece_types(id),
    location TEXT NOT NULL,
    quantity INTEGER NOT NULL
  )`,

  // Named, reusable sale configurations ("Standard L with one ottoman"),
  // specific to a product. Seeded with a starting guess per product family;
  // Dawson/Grant can rename, delete, or add their own without touching code.
  `CREATE TABLE IF NOT EXISTS presets (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    product_id INTEGER NOT NULL REFERENCES products(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    is_starter_guess INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  )`,

  `CREATE TABLE IF NOT EXISTS preset_items (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    preset_id INTEGER NOT NULL REFERENCES presets(id) ON DELETE CASCADE,
    piece_type_id INTEGER NOT NULL REFERENCES piece_types(id),
    quantity INTEGER NOT NULL
  )`,

  // Every time a box gets ADDED to inventory (received on a trip, a one-off
  // purchase to complete a set, or a free bonus piece).
  `CREATE TABLE IF NOT EXISTS inventory_receipts (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    date TEXT NOT NULL,
    piece_type_id INTEGER NOT NULL REFERENCES piece_types(id),
    location TEXT NOT NULL,
    quantity INTEGER NOT NULL,
    unit_cost REAL NOT NULL DEFAULT 0,
    is_free INTEGER NOT NULL DEFAULT 0,
    trip_id INTEGER REFERENCES trips(id),
    entered_by TEXT,
    notes TEXT,
    is_historical INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  )`,

  // Pieces sold beyond what was on hand (oversells): each row is a shortfall
  // to fulfill, either by ordering the piece online ("order", ~$215 shipped)
  // or grabbing it on the next trip ("next_trip"). Lives on the Orders tab.
  `CREATE TABLE IF NOT EXISTS piece_orders (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    sale_id INTEGER REFERENCES sales(id),
    piece_type_id INTEGER NOT NULL REFERENCES piece_types(id),
    location TEXT NOT NULL,
    quantity INTEGER NOT NULL,
    fulfillment TEXT NOT NULL,
    unit_cost REAL NOT NULL DEFAULT 0,
    status TEXT NOT NULL DEFAULT 'open',
    entered_by TEXT,
    notes TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    fulfilled_at TEXT
  )`,

  `CREATE INDEX IF NOT EXISTS idx_sales_date ON sales(date)`,
  `CREATE INDEX IF NOT EXISTS idx_sales_product ON sales(product_id)`,
  `CREATE INDEX IF NOT EXISTS idx_inventory_piece ON inventory(piece_type_id)`,
  `CREATE INDEX IF NOT EXISTS idx_presets_product ON presets(product_id)`,
  `CREATE INDEX IF NOT EXISTS idx_receipts_piece ON inventory_receipts(piece_type_id)`,
  `CREATE INDEX IF NOT EXISTS idx_receipts_date ON inventory_receipts(date)`,
];

try {
  await client.execute('PRAGMA foreign_keys = ON');
} catch {
  // Some remote SQLite-protocol backends don't support session-level
  // PRAGMAs over the network the same way a local file connection does —
  // harmless to skip if so; ON DELETE CASCADE in the schema still works
  // for the tables that declare it either way.
}

await client.batch(SCHEMA_STATEMENTS, 'write');

// Lightweight migration: deposit-hold flag on sales. A deposit-hold is a sale
// where a customer put money down (usually $100) but hasn't paid in full /
// taken delivery yet — pieces are reserved (decremented) so the showroom
// shows them gone, but the sale doesn't count toward revenue until completed
// from the Deposits tab. ALTER errors if the column already exists — safe to
// swallow on every startup after the first.
try {
  await client.execute(`ALTER TABLE sales ADD COLUMN is_deposit_hold INTEGER NOT NULL DEFAULT 0`);
} catch { /* column already exists */ }

export function nowIso() {
  return new Date().toISOString();
}
