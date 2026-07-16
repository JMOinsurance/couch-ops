// One-off data fix (2026-07-16): sales logged from 2026-07-11 onward came
// from Trip 15 but were saved before sales auto-linked to the latest trip.
// Links any of them that are missing a trip to Trip 15.
import { db } from '../src/db.js';

const trip = await db.get(`SELECT id, trip_number, date FROM trips WHERE trip_number = 15`);
if (!trip) { console.error('Trip 15 not found — nothing changed.'); process.exit(1); }

const before = await db.all(`SELECT id, date, trip_id FROM sales WHERE date >= '2026-07-11' AND is_historical = 0`);
console.log(`Sales on/after 2026-07-11: ${before.length}`);
for (const s of before) console.log(`  sale #${s.id}  ${s.date}  trip_id=${s.trip_id}`);

const res = await db.run(
  `UPDATE sales SET trip_id = ? WHERE date >= '2026-07-11' AND is_historical = 0 AND trip_id IS NULL`,
  [trip.id]
);
console.log(`Linked ${res.changes} sale(s) to Trip ${trip.trip_number} (id ${trip.id}, ${trip.date}).`);
process.exit(0);
