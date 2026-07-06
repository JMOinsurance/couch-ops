// Helpers for the sale-logging flow: raw piece stock (no "sellable couches"
// abstraction — Dawson/Grant told me that framing doesn't match how flexibly
// they actually configure couches) and preset lookups.

import { db } from './db.js';

/** Every piece type for a product, with on-hand counts by location. Just facts. */
export async function piecesForProduct(productId) {
  const pieceTypes = await db.all(
    `SELECT * FROM piece_types WHERE product_id = ? ORDER BY piece_number`, [productId]
  );
  return Promise.all(pieceTypes.map(async pt => {
    const rows = await db.all(`SELECT location, quantity FROM inventory WHERE piece_type_id = ?`, [pt.id]);
    const byLocation = { Dawson: 0, Grant: 0 };
    for (const r of rows) byLocation[r.location] = r.quantity;
    return { ...pt, byLocation, total: byLocation.Dawson + byLocation.Grant };
  }));
}

/** Presets for a product, each with its piece breakdown and a combined-stock availability count. */
export async function presetsForProduct(productId) {
  const presets = await db.all(`SELECT * FROM presets WHERE product_id = ? ORDER BY id`, [productId]);
  return Promise.all(presets.map(async preset => {
    const items = await db.all(`
      SELECT preset_items.quantity, piece_types.id AS piece_type_id, piece_types.label, piece_types.full_sku, piece_types.piece_number
      FROM preset_items JOIN piece_types ON piece_types.id = preset_items.piece_type_id
      WHERE preset_items.preset_id = ? ORDER BY piece_types.piece_number
    `, [preset.id]);

    let maxAvailable = Infinity;
    const missing = [];
    for (const item of items) {
      const onHandRow = await db.get(`SELECT COALESCE(SUM(quantity),0) s FROM inventory WHERE piece_type_id = ?`, [item.piece_type_id]);
      const totalOnHand = onHandRow.s;
      maxAvailable = Math.min(maxAvailable, Math.floor(totalOnHand / item.quantity));
      if (totalOnHand < item.quantity) {
        missing.push({ label: item.label, have: totalOnHand, need: item.quantity, short: item.quantity - totalOnHand });
      }
    }
    if (!isFinite(maxAvailable)) maxAvailable = 0;

    return { ...preset, items, maxAvailable, missing };
  }));
}

export async function presetById(presetId) {
  const preset = await db.get(`SELECT * FROM presets WHERE id = ?`, [presetId]);
  if (!preset) return null;
  const items = await db.all(`
    SELECT preset_items.quantity, piece_types.id AS piece_type_id, piece_types.label, piece_types.full_sku, piece_types.piece_number
    FROM preset_items JOIN piece_types ON piece_types.id = preset_items.piece_type_id
    WHERE preset_items.preset_id = ? ORDER BY piece_types.piece_number
  `, [presetId]);
  return { ...preset, items };
}

export async function totalOnHandForProduct(productId) {
  const row = await db.get(`
    SELECT COALESCE(SUM(inventory.quantity), 0) s FROM inventory
    JOIN piece_types ON piece_types.id = inventory.piece_type_id
    WHERE piece_types.product_id = ?
  `, [productId]);
  return row.s;
}
