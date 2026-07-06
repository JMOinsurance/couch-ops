// Wipes the (Turso-hosted) database and re-imports the historical data fresh.
// Useful while testing — NOT something to run once this is your real,
// live, day-to-day data (it deletes everything and starts over).
//
// Now that the database lives on Turso instead of a local .db file, "wipe"
// means deleting every row from every table (over the network) rather than
// unlinking a file on disk. Order matters here even with ON DELETE CASCADE
// declared in the schema, since some libSQL/remote backends don't always
// enforce FK actions the same way a local SQLite file connection would — so
// this deletes child tables before parents explicitly, rather than relying
// on cascade alone.

import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { db } from '../src/db.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Children first, parents last.
const TABLES_IN_DELETE_ORDER = [
  'preset_items',
  'presets',
  'sale_items',
  'sales',
  'inventory_receipts',
  'trip_photos',
  'trips',
  'inventory',
  'piece_types',
  'products',
  'sessions',
  'users',
];

async function wipe() {
  for (const table of TABLES_IN_DELETE_ORDER) {
    await db.run(`DELETE FROM ${table}`);
  }
  console.log('Old database rows removed. Re-importing historical data...\n');
}

await wipe();

// execFileSync (not execSync) with an argument array — this runs the script
// directly without going through a shell command line at all, so folder
// names with spaces (like "Couch Business") can't get split apart and break
// the path, which is exactly what happened before this fix.
execFileSync(process.execPath, ['--env-file=.env', path.join(__dirname, 'import-legacy-data.js')], {
  stdio: 'inherit',
  cwd: path.join(__dirname, '..'),
});
