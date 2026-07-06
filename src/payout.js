// Real payout math, from Dawson: base sale price always splits 50/50.
// Delivery and assembly fees go entirely to whoever performed that job —
// except sometimes delivery gets split between both partners, so "Both"
// is a valid value there too (50/50 on just that fee).

export function partnerEarnings(sale) {
  const base = sale.base_price || 0;
  const delivery = sale.delivery_fee || 0;
  const assembly = sale.assembly_fee || 0;

  const earnings = { Dawson: base / 2, Grant: base / 2 };

  applyFee(earnings, delivery, sale.delivery_by);
  applyFee(earnings, assembly, sale.assembly_by);

  return earnings;
}

function applyFee(earnings, amount, by) {
  if (!amount) return;
  if (by === 'Both') {
    earnings.Dawson += amount / 2;
    earnings.Grant += amount / 2;
  } else if (by === 'Dawson' || by === 'Grant') {
    earnings[by] += amount;
  }
  // else: no delivery/assembly performed by either partner (customer pickup, etc) — goes nowhere.
}
