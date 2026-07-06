// Starting-price suggestions by total piece count, from Dawson directly.
// Ottomans count as a piece toward this total. These are STARTING POINTS,
// never locked or enforced — sometimes a discount applies, and the sale
// form's price field always stays freely editable.
//
//   5 pieces -> $1,100   (confirmed by Dawson)
//   6 pieces -> $1,300   (confirmed by Dawson)
//   7 pieces -> $1,500   (confirmed by Dawson)
//   8 pieces -> $1,750   (confirmed by Dawson)
// (+ $100 for delivery, +$100 for setup/assembly — already separate fields)
//
//   2/3/4 pieces -> $500 / $700 / $900  (added 2026-07 for the new small
//   loveseat/couch/chaise presets — NOT independently confirmed by Dawson.
//   Extrapolated by continuing the same $200-per-piece step the 4 confirmed
//   points above already follow. Flag for his review before relying on it.)

const PRICE_BY_PIECE_COUNT = {
  2: 500,
  3: 700,
  4: 900,
  5: 1100,
  6: 1300,
  7: 1500,
  8: 1750,
};

/** Returns a suggested starting price, or null if we don't have a rule for that piece count. */
export function suggestedPrice(totalPieces) {
  return PRICE_BY_PIECE_COUNT[totalPieces] ?? null;
}
