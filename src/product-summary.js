import { db } from './db.js';
import { colorName, colorSwatch, searchTerms } from './colors.js';
import { piecesForProduct } from './sale-logic.js';

export async function activeProductSummaries({ includeInactive = false } = {}) {
  const products = await db.all(
    `SELECT * FROM products ${includeInactive ? '' : 'WHERE active = 1'} ORDER BY model, color`
  );
  return Promise.all(products.map(async p => {
    // Per-piece breakdown (what pieces, how many of each, at each location) —
    // powers the "what do we actually have" dropdown on the product tiles.
    // Overall total/byLocation are just sums across these pieces.
    const pieces = await piecesForProduct(p.id);
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
      pieces: pieces.map(pt => ({ id: pt.id, label: pt.label, full_sku: pt.full_sku, byLocation: pt.byLocation, total: pt.total })),
    };
  }));
}
