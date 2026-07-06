import { db } from './db.js';
import { colorName, colorSwatch, searchTerms } from './colors.js';

// Per-piece breakdown (what pieces, how many of each, at each location) —
// powers the "what do we actually have" dropdown on the product tiles.
// Overall total/byLocation are just sums across these pieces.
//
// This used to call piecesForProduct() per product (2 queries each), which
// meant a full catalog page was ~150 round-trips to Turso — fine against the
// in-process test database, but slow enough against the real remote database
// to make the home page feel like it hung. Now it's 3 queries total no
// matter how many products there are: fetch everything, group in memory.
export async function activeProductSummaries({ includeInactive = false } = {}) {
  const products = await db.all(
    `SELECT * FROM products ${includeInactive ? '' : 'WHERE active = 1'} ORDER BY model, color`
  );
  if (products.length === 0) return [];
  const productIds = products.map(p => p.id);
  const placeholders = productIds.map(() => '?').join(',');

  const allPieceTypes = await db.all(
    `SELECT * FROM piece_types WHERE product_id IN (${placeholders}) ORDER BY product_id, piece_number`,
    productIds
  );
  const pieceTypeIds = allPieceTypes.map(pt => pt.id);
  let allInvRows = [];
  if (pieceTypeIds.length) {
    const ph2 = pieceTypeIds.map(() => '?').join(',');
    allInvRows = await db.all(
      `SELECT * FROM inventory WHERE piece_type_id IN (${ph2})`,
      pieceTypeIds
    );
  }

  const invByPiece = {};
  for (const row of allInvRows) (invByPiece[row.piece_type_id] ||= []).push(row);
  const pieceTypesByProduct = {};
  for (const pt of allPieceTypes) (pieceTypesByProduct[pt.product_id] ||= []).push(pt);

  return products.map(p => {
    const pieces = (pieceTypesByProduct[p.id] || []).map(pt => {
      const rows = invByPiece[pt.id] || [];
      const byLocation = { Dawson: 0, Grant: 0 };
      for (const r of rows) byLocation[r.location] = r.quantity;
      return { id: pt.id, label: pt.label, full_sku: pt.full_sku, byLocation, total: byLocation.Dawson + byLocation.Grant };
    });
    const byLocation = { Dawson: 0, Grant: 0 };
    let total = 0;
    for (const pt of pieces) {
      byLocation.Dawson += pt.byLocation.Dawson;
      byLocation.Grant += pt.byLocation.Grant;
      total += pt.total;
    }
    return {
      ...p,
      colorName: colorName(p.color),
      // space-joined alias terms (e.g. "tan brown") so client-side search
      // matches "Brown" for a Tan-coded product, "Gray" for Light Grey, etc.
      colorSearchTerms: searchTerms(p.color).join(' '),
      swatch: colorSwatch(p.color),
      total,
      byLocation,
      pieces,
    };
  });
}
