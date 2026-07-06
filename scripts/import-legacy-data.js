// One-time import of the 11 months of history from the old Google Sheet
// (Inventory tab + Operations tab) into the new database.
//
// Source data was exported from the real spreadsheet into plain JSON fixtures
// under data/legacy-export/ (inventory.json, trips.json, sales.json) so this
// script has no dependency on an xlsx/csv parsing library.
//
// Run with: npm run import-legacy
//
// NOTE on transactions: this used to run inside an explicit BEGIN/COMMIT so a
// mid-script failure would leave nothing behind. The old local-file db.exec()
// helper doesn't exist anymore now that this runs against Turso over the
// network (see src/db.js), so this no longer wraps everything in one
// transaction. That's fine in practice — this script is only ever meant to
// be run right after `npm run reset-db` wipes the database clean, so a
// failure partway through just means re-running reset-db and trying again,
// same as before.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { db } from '../src/db.js';
import { rulesForModel } from '../src/product-rules.js';
import { presetsForModel } from '../src/preset-seeds.js';
import { ensureUser } from '../src/auth.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const EXPORT_DIR = path.join(__dirname, '..', 'data', 'legacy-export');

function readJson(name) {
  return JSON.parse(fs.readFileSync(path.join(EXPORT_DIR, name), 'utf8'));
}

// "18-Aug" -> "2025-08-18". Aug-Dec is treated as the first year of the
// business's tracked history (2025), Jan-Jul as the following year (2026),
// matching "11 months and 0 days" since the first trip (3-Aug) as of the
// point this app was built. If you re-run this a long time from now, that's
// fine — it's only used to order historical rows, not for anything live.
const MONTHS = { Jan: 1, Feb: 2, Mar: 3, Apr: 4, May: 5, Jun: 6, Jul: 7, Aug: 8, Sep: 9, Oct: 10, Nov: 11, Dec: 12 };
function parseLegacyDate(str, { fixKnownTypo = false } = {}) {
  const [dayStr, monStr] = str.split('-');
  let day = parseInt(dayStr, 10);
  let mon = MONTHS[monStr];
  const year = mon >= 8 ? 2025 : 2026;
  return `${year}-${String(mon).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

function parseSku(fullOrModelColor) {
  const m = fullOrModelColor.match(/^(\d{3})([A-Z]{2})(?:-(\d+))?$/);
  if (!m) return null;
  return { model: m[1], color: m[2], pieceNumber: m[3] ? parseInt(m[3], 10) : null };
}

async function ensureProduct(model, color) {
  const sku = `${model}${color}`;
  let product = await db.get(`SELECT * FROM products WHERE sku = ?`, [sku]);
  if (product) return product;

  const rules = rulesForModel(model);
  await db.run(
    `INSERT INTO products (model, color, sku, display_name, active, rules_confidence, notes) VALUES (?, ?, ?, ?, 1, ?, ?)`,
    [model, color, sku, sku, rules.confidence, rules.notes]
  );
  product = await db.get(`SELECT * FROM products WHERE sku = ?`, [sku]);
  return product;
}

async function ensurePieceType(product, pieceNumber) {
  const fullSku = `${product.sku}-${pieceNumber}`;
  let pt = await db.get(`SELECT * FROM piece_types WHERE full_sku = ?`, [fullSku]);
  if (pt) return pt;

  const rules = rulesForModel(product.model);
  const def = rules.pieces[pieceNumber];
  const label = def ? def.label : `Piece ${pieceNumber} (unlisted)`;
  const requirement = def ? def.requirement : 'OPTIONAL';

  await db.run(
    `INSERT INTO piece_types (product_id, piece_number, full_sku, label, requirement) VALUES (?, ?, ?, ?, ?)`,
    [product.id, pieceNumber, fullSku, label, requirement]
  );
  return db.get(`SELECT * FROM piece_types WHERE full_sku = ?`, [fullSku]);
}

async function mergeProduct(fromSku, intoSku, reason) {
  const from = await db.get(`SELECT * FROM products WHERE sku = ?`, [fromSku]);
  const into = await db.get(`SELECT * FROM products WHERE sku = ?`, [intoSku]);
  if (!from || !into) return;

  const fromPieces = await db.all(`SELECT * FROM piece_types WHERE product_id = ?`, [from.id]);
  for (const fp of fromPieces) {
    const intoPiece = await ensurePieceType(into, fp.piece_number);
    const invRows = await db.all(`SELECT * FROM inventory WHERE piece_type_id = ?`, [fp.id]);
    for (const inv of invRows) {
      const existing = await db.get(`SELECT id, quantity FROM inventory WHERE piece_type_id = ? AND location = ?`, [intoPiece.id, inv.location]);
      if (existing) {
        await db.run(`UPDATE inventory SET quantity = quantity + ? WHERE id = ?`, [inv.quantity, existing.id]);
      } else {
        await db.run(`INSERT INTO inventory (piece_type_id, location, quantity) VALUES (?, ?, ?)`, [intoPiece.id, inv.location, inv.quantity]);
      }
    }
  }
  await db.run(`UPDATE sales SET product_id = ? WHERE product_id = ?`, [into.id, from.id]);
  await db.run(`DELETE FROM products WHERE id = ?`, [from.id]); // cascades piece_types + inventory for the old row
  await db.run(`UPDATE products SET notes = ? WHERE id = ?`, [
    `${into.notes ? into.notes + ' | ' : ''}Merged from "${fromSku}": ${reason}`, into.id
  ]);
  console.log(`Correction applied: merged "${fromSku}" into "${intoSku}" — ${reason}`);
}

async function applyKnownCorrections() {
  // Dawson confirmed: the 151 line's real color code is "BL", and the master
  // inventory sheet had it mislabeled "GY". The GY row carries the real
  // on-hand inventory counts, so fold it into BL (creating BL if needed).
  await ensureProduct('151', 'BL');
  await mergeProduct('151GY', '151BL', 'master inventory sheet had this color mislabeled "GY"; Dawson confirmed the real code is "BL". Inventory counts carried over.');

  // Dawson confirmed BU and BL are the same color (Blue) — two codes that
  // ended up used for one thing. BU currently has zero stock, so this is a
  // clean, no-loss merge into BL (the code Dawson said is correct for 151).
  await mergeProduct('151BU', '151BL', 'Dawson confirmed BU and BL are both "Blue" — the same color under two different codes. Merged the (empty) BU line into BL.');

  // Dawson confirmed the sales-log "151LG" entries were a typo, but wasn't
  // sure what the intended code was. Rather than guess, flag it clearly
  // instead of silently reassigning it to BL or BU.
  const suspect = await db.get(`SELECT * FROM products WHERE sku = '151LG'`);
  if (suspect) {
    await db.run(`UPDATE products SET rules_confidence = 'UNCONFIRMED', notes = ? WHERE id = ?`, [
      'Dawson confirmed this SKU was a typo on 2 historical sales, but was not sure what the correct code should have been (possibly 151BL/Blue). Left as its own record rather than guessing — reassign those 2 sales to the correct product once confirmed.',
      suspect.id
    ]);
    console.log('Correction flagged (not auto-applied): "151LG" is a known typo of unknown intent — left for manual reassignment.');
  }

  // Dawson confirmed models 126 and 143 are discontinued — no longer purchased.
  const discontinued = await db.all(`SELECT id, sku FROM products WHERE model IN ('126', '143')`);
  for (const p of discontinued) {
    await db.run(`UPDATE products SET active = 0, notes = ? WHERE id = ?`, [
      'Discontinued — Dawson confirmed this model is no longer purchased on supply trips. Kept for sales history; excluded from reorder/low-stock alerts.',
      p.id
    ]);
  }
  if (discontinued.length) {
    console.log(`Correction applied: marked ${discontinued.length} product(s) from discontinued models 126/143 as inactive.`);
  }
}

async function seedPresets() {
  const products = await db.all(`SELECT * FROM products WHERE active = 1`);
  let count = 0;
  for (const product of products) {
    const existingRow = await db.get(`SELECT COUNT(*) c FROM presets WHERE product_id = ?`, [product.id]);
    if (existingRow.c > 0) continue; // don't re-seed over anything already there (e.g. user-created presets)
    const seeds = presetsForModel(product.model);
    for (const seed of seeds) {
      const info = await db.run(`INSERT INTO presets (product_id, name, is_starter_guess) VALUES (?, ?, ?)`, [product.id, seed.name, seed.unconfirmed ? 1 : 0]);
      for (const [pieceNumber, qty] of Object.entries(seed.pieces)) {
        if (qty <= 0) continue;
        const pt = await db.get(`SELECT id FROM piece_types WHERE product_id = ? AND piece_number = ?`, [product.id, parseInt(pieceNumber, 10)]);
        if (pt) {
          await db.run(`INSERT INTO preset_items (preset_id, piece_type_id, quantity) VALUES (?, ?, ?)`, [info.lastInsertRowid, pt.id, qty]);
        }
      }
      count++;
    }
  }
  console.log(`Seeded ${count} starter presets across ${products.length} active products.`);
}

async function main() {
  await ensureUser('Dawson');
  await ensureUser('Grant');
  console.log('Users ready: Dawson, Grant (no password — just pick your name).');

  const inventory = readJson('inventory.json');
  const trips = readJson('trips.json');
  const sales = readJson('sales.json');

  console.log(`Loaded ${inventory.length} inventory rows, ${trips.length} trips, ${sales.length} sales.`);

  // --- 1. Inventory: creates every product + piece type + on-hand counts ---
  for (const row of inventory) {
    const parsed = parseSku(row.full_sku);
    if (!parsed || parsed.pieceNumber == null) {
      console.warn(`Skipping unparseable inventory SKU: ${row.full_sku}`);
      continue;
    }
    const product = await ensureProduct(parsed.model, parsed.color);
    const pieceType = await ensurePieceType(product, parsed.pieceNumber);

    for (const [location, qty] of [['Dawson', row.dawson_qty], ['Grant', row.grant_qty]]) {
      const existing = await db.get(`SELECT id FROM inventory WHERE piece_type_id = ? AND location = ?`, [pieceType.id, location]);
      if (existing) {
        await db.run(`UPDATE inventory SET quantity = ? WHERE id = ?`, [qty, existing.id]);
      } else {
        await db.run(`INSERT INTO inventory (piece_type_id, location, quantity) VALUES (?, ?, ?)`, [pieceType.id, location, qty]);
      }
    }
  }
  const productsCreated = (await db.get(`SELECT COUNT(*) c FROM products`)).c;
  const pieceTypesCreated = (await db.get(`SELECT COUNT(*) c FROM piece_types`)).c;
  console.log(`Products: ${productsCreated}, piece types: ${pieceTypesCreated}`);

  // --- 2. Trips ---
  const tripIdByNumber = {};
  for (const t of trips) {
    const iso = parseLegacyDate(t.date);
    const info = await db.run(
      `INSERT INTO trips (trip_number, date, traveler, boxes_expected, boxes_actual, total_cost, gas_cost, notes, is_historical)
       VALUES (?, ?, NULL, ?, ?, ?, NULL, ?, 1)`,
      [
        t.trip_number, iso, t.boxes, t.boxes, t.cost,
        'Imported from legacy spreadsheet. Expected/actual box counts were not tracked separately historically, so both are set to the logged box count — this is exactly the gap the new reconciliation step is meant to close going forward.'
      ]
    );
    tripIdByNumber[t.trip_number] = info.lastInsertRowid;
  }
  console.log(`Imported ${trips.length} historical trips.`);

  // --- 3. Sales ---
  let salesImported = 0, dateFixCount = 0;
  for (const s of sales) {
    const parsed = parseSku(s.sku);
    let productId = null;
    if (parsed) {
      const product = await ensureProduct(parsed.model, parsed.color);
      productId = product.id;
    } else {
      console.warn(`Sale with unparseable SKU "${s.sku}" imported without a product link.`);
    }

    let isoDate = parseLegacyDate(s.date);
    let notes = 'Imported from legacy spreadsheet. Delivery/assembly fee attribution was not tracked historically, so the full amount is recorded as base price split 50/50.';

    // Known data-entry error: trip 14's "29-Jan" sale sits between two
    // June dates for the same trip. Corrected to 29-Jun with an audit note
    // rather than silently left as a date that would sort into the wrong year.
    if (s.trip_number === 14 && s.date === '29-Jan') {
      isoDate = '2026-06-29';
      notes += ' NOTE: original sheet had this dated "29-Jan", which sat out of order inside a run of June dates for the same trip — corrected to 29-Jun as a near-certain data-entry typo (day kept, month corrected). Flagged here for the record.';
      dateFixCount++;
    }

    await db.run(
      `INSERT INTO sales (date, product_id, trip_id, pieces_total, base_price, delivery_fee, delivery_by, assembly_fee, assembly_by, payment_method, payment_status, notes, is_historical)
       VALUES (?, ?, ?, ?, ?, 0, NULL, 0, NULL, NULL, 'Paid', ?, 1)`,
      [isoDate, productId, tripIdByNumber[s.trip_number] || null, s.pieces, s.sold, notes]
    );
    salesImported++;
  }
  console.log(`Imported ${salesImported} historical sales (${dateFixCount} date correction applied).`);

  // --- 4. Known data-quality corrections, applied explicitly and logged ---
  // (Rather than silently guessing, or leaving obviously-wrong codes in place.)
  await applyKnownCorrections();
  await seedPresets();

  // --- Sanity check against the numbers verified from the original spreadsheet ---
  const totalBoxesPurchased = (await db.get(`SELECT SUM(boxes_actual) s FROM trips WHERE is_historical = 1`)).s;
  const totalPiecesSold = (await db.get(`SELECT SUM(pieces_total) s FROM sales WHERE is_historical = 1`)).s;
  const totalGross = (await db.get(`SELECT SUM(base_price) s FROM sales WHERE is_historical = 1`)).s;
  const totalCost = (await db.get(`SELECT SUM(total_cost) s FROM trips WHERE is_historical = 1`)).s;
  const currentInventory = (await db.get(`SELECT SUM(quantity) s FROM inventory`)).s;
  const saleCount = (await db.get(`SELECT COUNT(*) c FROM sales WHERE is_historical = 1`)).c;

  console.log('\n--- Sanity check vs. original spreadsheet ---');
  console.log(`Total boxes purchased (trips):  ${totalBoxesPurchased}  (spreadsheet: 848)`);
  console.log(`Total sales transactions:       ${saleCount}  (spreadsheet: 134)`);
  console.log(`Total pieces sold:              ${totalPiecesSold}  (spreadsheet: 790, derived)`);
  console.log(`Total gross sales:               $${totalGross}  (spreadsheet: $183,250)`);
  console.log(`Total trip cost:                 $${totalCost}  (spreadsheet: $65,566)`);
  console.log(`Current inventory (both locations): ${currentInventory}  (spreadsheet: 107)`);
  console.log(`Known unreconciled gap (purchased ${totalBoxesPurchased} - sold ${totalPiecesSold} = ${totalBoxesPurchased - totalPiecesSold} expected vs. ${currentInventory} actual on hand): ${currentInventory - (totalBoxesPurchased - totalPiecesSold)} boxes — this is the real-world counting-error gap Dawson described, imported as-is rather than papered over.`);
}

await main();
