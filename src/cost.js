// Box-cost helpers. From Dawson directly: normal cost is $75/box; 120WE is
// discounted to $50/box; occasionally extra pieces come free. Separately,
// there's an online-ordering option where he orders 2 boxes at $150 EACH
// ($300 total) — that's pricier than the normal $75/box, not a bundle
// discount, so it's surfaced as an opt-in toggle on the Add Inventory form
// rather than baked into the default suggestion. These are all STARTING
// points — always editable, never enforced, since real purchases vary (a
// one-off piece "for random price" to complete a set, etc).

import { db } from './db.js';

const DEFAULT_COST_PER_BOX = 75;
const DISCOUNTED_SKUS = { '120WE': 50 };
export const ONLINE_ORDER_COST_PER_BOX = 150;

/** Suggested $/box for a product, before the user edits it. */
export function suggestedUnitCost(sku) {
  return DISCOUNTED_SKUS[sku] ?? DEFAULT_COST_PER_BOX;
}

/**
 * Blended average $/box actually paid, across both historical bulk trip
 * purchases (total_cost / boxes_actual) and the newer granular per-piece
 * inventory_receipts log (unit_cost, free ones excluded from the cost side
 * but their existence doesn't affect this rate calculation either way).
 * This is what boxes COST us — used for "Total cost" stats and profit math.
 * NOTE: "Expected $" (what inventory on hand is worth) uses the SALE-side
 * rate instead — see avgSoldPricePerBox() in stats.js — since that's what
 * these boxes actually go for once sold, not what we paid for them.
 */
export async function avgCostPerBox() {
  const trip = await db.get(`SELECT COALESCE(SUM(total_cost),0) c, COALESCE(SUM(boxes_actual),0) b FROM trips`);
  const receipt = await db.get(`SELECT COALESCE(SUM(unit_cost * quantity),0) c, COALESCE(SUM(quantity),0) b FROM inventory_receipts WHERE is_free = 0`);
  const totalCost = trip.c + receipt.c;
  const totalBoxes = trip.b + receipt.b;
  return totalBoxes > 0 ? totalCost / totalBoxes : 0;
}
