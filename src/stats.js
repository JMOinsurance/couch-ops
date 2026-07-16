// All the "how's the business doing" number-crunching in one place, so the
// Dashboard and Stats page pull from the same source instead of drifting.

import { db } from './db.js';
import { partnerEarnings } from './payout.js';

export async function avgSalePrice() {
  const row = await db.get(`SELECT AVG(base_price + delivery_fee + assembly_fee) a, COUNT(*) c FROM sales WHERE COALESCE(is_deposit_hold,0) = 0`);
  return { avg: row.a || 0, count: row.c || 0 };
}

/** Most recent N sales, newest first — for a dashboard "last sold" strip. */
export async function recentSales(limit = 5) {
  return db.all(`
    SELECT sales.id, sales.date, sales.base_price, sales.delivery_fee, sales.assembly_fee,
           products.sku, products.color
    FROM sales LEFT JOIN products ON products.id = sales.product_id
    WHERE COALESCE(sales.is_deposit_hold,0) = 0
    ORDER BY sales.date DESC, sales.id DESC
    LIMIT ?
  `, [limit]);
}

export async function bestSellers(limit = 10) {
  return db.all(`
    SELECT products.sku, products.color, products.model, COUNT(*) saleCount, COALESCE(SUM(sales.pieces_total),0) piecesSold,
           COALESCE(SUM(sales.base_price + sales.delivery_fee + sales.assembly_fee),0) revenue
    FROM sales JOIN products ON products.id = sales.product_id
    WHERE COALESCE(sales.is_deposit_hold,0) = 0
    GROUP BY sales.product_id
    ORDER BY saleCount DESC
    LIMIT ?
  `, [limit]);
}

export async function salesByModel() {
  return db.all(`
    SELECT products.model, COUNT(*) saleCount, COALESCE(SUM(sales.base_price + sales.delivery_fee + sales.assembly_fee),0) revenue
    FROM sales JOIN products ON products.id = sales.product_id
    WHERE COALESCE(sales.is_deposit_hold,0) = 0
    GROUP BY products.model
    ORDER BY saleCount DESC
  `);
}

export async function salesByColor() {
  return db.all(`
    SELECT products.color, COUNT(*) saleCount
    FROM sales JOIN products ON products.id = sales.product_id
    WHERE COALESCE(sales.is_deposit_hold,0) = 0
    GROUP BY products.color
    ORDER BY saleCount DESC
  `);
}

export async function perTripStats() {
  const trips = await db.all(`SELECT * FROM trips ORDER BY date`);
  return Promise.all(trips.map(async t => {
    // "Sets sold" = number of couches (sales) linked to this trip, not raw
    // piece count — a half-couch bought on one trip and completed on the
    // next still just counts as one set, on whichever trip it's logged
    // under. No sell-through % here on purpose: pieces bought on one trip
    // sometimes complete a couch counted under a later trip, so a clean
    // "boxes in vs. boxes sold" ratio per trip doesn't hold up.
    const sold = await db.get(`SELECT COUNT(*) c, COALESCE(SUM(base_price + delivery_fee + assembly_fee),0) r FROM sales WHERE trip_id = ? AND COALESCE(is_deposit_hold,0) = 0`, [t.id]);
    const costPerBox = t.boxes_actual > 0 ? t.total_cost / t.boxes_actual : 0;
    return {
      ...t,
      setsSold: sold.c,
      grossSales: sold.r,
      costPerBox,
      netProfit: sold.r - t.total_cost - (t.gas_cost || 0),
    };
  }));
}

export async function timeInBusiness() {
  const row = await db.get(`SELECT MIN(date) d FROM trips`);
  const first = row.d;
  if (!first) return { firstDate: null, months: 0 };
  const start = new Date(first);
  const now = new Date();
  const months = Math.max(1, (now.getFullYear() - start.getFullYear()) * 12 + (now.getMonth() - start.getMonth()));
  return { firstDate: first, months };
}

export async function profitSummary() {
  const revRow = await db.get(`SELECT COALESCE(SUM(base_price + delivery_fee + assembly_fee),0) s FROM sales WHERE COALESCE(is_deposit_hold,0) = 0`);
  const tripRow = await db.get(`SELECT COALESCE(SUM(total_cost),0) s FROM trips`);
  const gasRow = await db.get(`SELECT COALESCE(SUM(gas_cost),0) s FROM trips`);
  const receiptRow = await db.get(`SELECT COALESCE(SUM(unit_cost * quantity),0) s FROM inventory_receipts WHERE is_free = 0`);
  const totalRevenue = revRow.s, totalTripCost = tripRow.s, totalGasCost = gasRow.s, totalReceiptCost = receiptRow.s;
  const totalProfit = totalRevenue - totalTripCost - totalGasCost - totalReceiptCost;
  const { months } = await timeInBusiness();
  const avgMonthlyProfit = totalProfit / months;

  // Partner split: base always 50/50, fees go by delivery_by/assembly_by
  // (with "Both" splitting that one fee 50/50) — sum it up sale by sale.
  const sales = await db.all(`SELECT base_price, delivery_fee, delivery_by, assembly_fee, assembly_by FROM sales WHERE COALESCE(is_deposit_hold,0) = 0`);
  const split = { Dawson: 0, Grant: 0 };
  for (const s of sales) {
    const e = partnerEarnings(s);
    split.Dawson += e.Dawson;
    split.Grant += e.Grant;
  }
  // Trip/receipt costs are shared costs of doing business — split evenly for
  // this summary rather than trying to attribute who paid for which box.
  const sharedCost = (totalTripCost + totalGasCost + totalReceiptCost) / 2;
  split.Dawson -= sharedCost;
  split.Grant -= sharedCost;

  return {
    totalRevenue, totalTripCost, totalGasCost, totalReceiptCost, totalProfit, avgMonthlyProfit,
    avgMonthlyProfitSplit: { Dawson: split.Dawson / months, Grant: split.Grant / months },
    allTimeSplit: split,
  };
}

export async function enteredByBreakdown() {
  const sales = await db.all(`SELECT entered_by, COUNT(*) c FROM sales WHERE entered_by IS NOT NULL GROUP BY entered_by`);
  const trips = await db.all(`SELECT entered_by, COUNT(*) c FROM trips WHERE entered_by IS NOT NULL GROUP BY entered_by`);
  const receipts = await db.all(`SELECT entered_by, COUNT(*) c FROM inventory_receipts WHERE entered_by IS NOT NULL GROUP BY entered_by`);
  const toMap = rows => Object.fromEntries(rows.map(r => [r.entered_by, r.c]));
  return { sales: toMap(sales), trips: toMap(trips), receipts: toMap(receipts) };
}

/** Avg $ actually brought in per box sold (gross base-price revenue / pieces sold) — this is a SALE-side rate, not a cost/purchase rate. Used for "what's my inventory worth" valuation, since that's what these boxes are actually worth once sold, not what they cost to buy. */
export async function avgSoldPricePerBox() {
  const row = await db.get(`SELECT COALESCE(SUM(base_price),0) rev, COALESCE(SUM(pieces_total),0) pieces FROM sales WHERE pieces_total > 0 AND COALESCE(is_deposit_hold,0) = 0`);
  return row.pieces > 0 ? row.rev / row.pieces : 0;
}

export async function expectedInventoryValue() {
  const row = await db.get(`SELECT COALESCE(SUM(quantity),0) s FROM inventory`);
  const rate = await avgSoldPricePerBox();
  return { totalBoxes: row.s, rate, value: row.s * rate };
}
