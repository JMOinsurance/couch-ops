// Core "can we actually sell this" logic. This is the piece of business logic
// that never existed in the spreadsheet — everything else in the app builds on it.

import { db } from './db.js';

/**
 * For a given product, compute:
 *  - sellable: how many complete couches can be built right now (the minimum
 *    on-hand quantity across all REQUIRED piece types, summed across both
 *    locations — a couch can be assembled from either partner's stock, it's
 *    just a question of who drives it).
 *  - strandedBoxes: total boxes on hand that belong to this product but can't
 *    currently be part of a sellable couch, because some other REQUIRED piece
 *    type for this product is at zero.
 *  - byLocation: same sellable count, broken out per location, since a
 *    complete couch sitting half at Dawson's and half at Grant's still needs
 *    someone to combine them before it's actually deliverable.
 */
export async function productAvailability(productId) {
  const pieceTypes = await db.all(
    `SELECT id, piece_number, label, requirement, full_sku FROM piece_types WHERE product_id = ? ORDER BY piece_number`,
    [productId]
  );

  const invRows = await db.all(
    `SELECT piece_type_id, location, quantity FROM inventory WHERE piece_type_id IN (
       SELECT id FROM piece_types WHERE product_id = ?
     )`,
    [productId]
  );

  const totalsByPiece = {};   // piece_type_id -> total qty (both locations)
  const byLocationByPiece = {}; // piece_type_id -> { Dawson: n, Grant: n }
  for (const pt of pieceTypes) {
    totalsByPiece[pt.id] = 0;
    byLocationByPiece[pt.id] = { Dawson: 0, Grant: 0 };
  }
  for (const row of invRows) {
    totalsByPiece[row.piece_type_id] = (totalsByPiece[row.piece_type_id] || 0) + row.quantity;
    if (!byLocationByPiece[row.piece_type_id]) byLocationByPiece[row.piece_type_id] = { Dawson: 0, Grant: 0 };
    byLocationByPiece[row.piece_type_id][row.location] = row.quantity;
  }

  const requiredPieces = pieceTypes.filter(p => p.requirement === 'REQUIRED');
  const optionalPieces = pieceTypes.filter(p => p.requirement === 'OPTIONAL');

  const requiredCounts = requiredPieces.map(p => totalsByPiece[p.id] || 0);
  const sellable = requiredPieces.length === 0
    ? 0
    : Math.min(...requiredCounts);

  // Per-location sellable count uses the same min-across-required-pieces logic,
  // but restricted to that one location's stock.
  const byLocation = { Dawson: 0, Grant: 0 };
  for (const loc of ['Dawson', 'Grant']) {
    const counts = requiredPieces.map(p => byLocationByPiece[p.id]?.[loc] || 0);
    byLocation[loc] = requiredPieces.length === 0 ? 0 : Math.min(...counts);
  }

  // Stranded = on-hand boxes of any piece type (required or optional) beyond
  // what the bottleneck required piece can support.
  let strandedBoxes = 0;
  const strandedDetail = [];
  for (const pt of pieceTypes) {
    const onHand = totalsByPiece[pt.id] || 0;
    const usable = pt.requirement === 'REQUIRED' ? sellable : Math.min(onHand, sellable === 0 ? 0 : onHand);
    // For a required piece, anything above the bottleneck is stranded.
    // For an optional piece, if the bottleneck is 0, ALL of it is stranded
    // (no couch to attach it to); if the bottleneck is >0, optional pieces
    // are never "stranded" in the same sense since they attach to any unit.
    let strandedForThisPiece = 0;
    if (pt.requirement === 'REQUIRED') {
      strandedForThisPiece = Math.max(0, onHand - sellable);
    } else {
      strandedForThisPiece = sellable === 0 ? onHand : 0;
    }
    if (strandedForThisPiece > 0) {
      strandedDetail.push({ pieceNumber: pt.piece_number, label: pt.label, sku: pt.full_sku, strandedQty: strandedForThisPiece });
    }
    strandedBoxes += strandedForThisPiece;
  }

  const totalBoxesOnHand = Object.values(totalsByPiece).reduce((a, b) => a + b, 0);

  return {
    productId,
    sellable,
    byLocation,
    totalBoxesOnHand,
    strandedBoxes,
    strandedDetail,
    outOfStock: totalBoxesOnHand === 0,
    pieceTypes: pieceTypes.map(pt => ({
      ...pt,
      onHand: totalsByPiece[pt.id] || 0,
      byLocation: byLocationByPiece[pt.id],
    })),
  };
}

/** Availability summary across every active product — the core dashboard feed. */
export async function allProductsAvailability() {
  const products = await db.all(
    `SELECT id, model, color, sku, display_name, active, rules_confidence, notes FROM products ORDER BY model, color`
  );
  return Promise.all(products.map(async p => ({ product: p, availability: await productAvailability(p.id) })));
}
