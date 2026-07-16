// What did each open deposit take/hold, and what does the site show for that product now?
import { db } from '../src/db.js';

const holds = await db.all(`
  SELECT sales.id, sales.date, sales.customer_name, products.sku, products.model, products.color
  FROM sales LEFT JOIN products ON products.id = sales.product_id
  WHERE COALESCE(sales.is_deposit_hold,0) = 1`);
for (const h of holds) {
  console.log(`\nSale #${h.id} ${h.sku} (${h.customer_name || 'no name'}) ${h.date}`);
  const items = await db.all(`
    SELECT sale_items.quantity, sale_items.location, piece_types.label
    FROM sale_items JOIN piece_types ON piece_types.id = sale_items.piece_type_id WHERE sale_id = ?`, [h.id]);
  for (const i of items) console.log(`  HELD from stock: ${i.quantity}x ${i.label} @ ${i.location}`);
  const po = await db.all(`
    SELECT piece_orders.quantity, piece_orders.fulfillment, piece_orders.status, piece_types.label
    FROM piece_orders JOIN piece_types ON piece_types.id = piece_orders.piece_type_id WHERE sale_id = ?`, [h.id]);
  for (const o of po) console.log(`  SHORT (not from stock): ${o.quantity}x ${o.label} -> ${o.fulfillment} [${o.status}]`);
  // current combined inventory for that product
  const inv = await db.all(`
    SELECT piece_types.label, COALESCE(SUM(inventory.quantity),0) q
    FROM piece_types LEFT JOIN inventory ON inventory.piece_type_id = piece_types.id
    JOIN products ON products.id = piece_types.product_id
    WHERE products.sku = ? GROUP BY piece_types.id ORDER BY piece_types.piece_number`, [h.sku]);
  console.log('  inventory now: ' + inv.map(r => `${r.label}=${r.q}`).join(', '));
}
process.exit(0);
