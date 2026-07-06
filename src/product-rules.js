// Configurator rules per model line, from Dawson's description of how the
// piece-number suffix on each SKU (e.g. "121KH-1") maps to a physical part.
//
// requirement:
//   REQUIRED  -> every sellable couch of this product needs at least 1 of this
//                piece type. If this piece type hits 0 on hand, the product
//                cannot be sold at all, no matter what else is in stock.
//   OPTIONAL  -> the customer chooses how many of these to add (middles,
//                ottomans, wedges, etc). Doesn't gate whether a couch can be
//                sold, but is tracked as its own inventory line.
//
// confidence:
//   CONFIRMED    -> Dawson confirmed this directly.
//   UNCONFIRMED  -> best guess / needs verification against the supplier or
//                   the boxes themselves before being trusted for real
//                   trip-planning decisions. Surfaced in the UI as a flag.

export const MODEL_RULES = {
  '120': {
    confidence: 'CONFIRMED',
    notes: 'Confirmed by Dawson: needs at least one left-facing AND one right-facing piece.',
    pieces: {
      2: { label: 'Left-facing', requirement: 'REQUIRED' },
      3: { label: 'Right-facing', requirement: 'REQUIRED' },
      4: { label: 'Middle', requirement: 'OPTIONAL' },
      5: { label: 'Ottoman', requirement: 'OPTIONAL' },
      6: { label: 'Wedge', requirement: 'OPTIONAL' },
    },
  },
  '121': {
    confidence: 'CONFIRMED',
    notes: 'Confirmed by Dawson: needs at least one corner (reversible).',
    pieces: {
      1: { label: 'Corner (reversible)', requirement: 'REQUIRED' },
      2: { label: 'Middle', requirement: 'OPTIONAL' },
      3: { label: 'Ottoman', requirement: 'OPTIONAL' },
    },
  },
  '140': {
    confidence: 'CONFIRMED',
    notes: 'Confirmed by Dawson: needs at least one left-facing AND one right-facing piece.',
    pieces: {
      1: { label: 'Left-facing', requirement: 'REQUIRED' },
      2: { label: 'Right-facing', requirement: 'REQUIRED' },
      3: { label: 'Middle', requirement: 'OPTIONAL' },
      4: { label: 'Ottoman', requirement: 'OPTIONAL' },
      5: { label: 'Wedge', requirement: 'OPTIONAL' },
    },
  },
  '141': {
    confidence: 'CONFIRMED',
    notes: 'Confirmed by Dawson: same layout as 121 (corner / middle / ottoman).',
    pieces: {
      1: { label: 'Corner (reversible)', requirement: 'REQUIRED' },
      2: { label: 'Middle', requirement: 'OPTIONAL' },
      3: { label: 'Ottoman', requirement: 'OPTIONAL' },
    },
  },
  '142': {
    confidence: 'CONFIRMED',
    notes: 'Confirmed by Dawson: same corner/middle/ottoman layout as 121/141 — he gave real preset numbers (Small L, L, Costco U, Big U, Ultra) explicitly covering 121, 141, and 142 together.',
    pieces: {
      1: { label: 'Corner (reversible)', requirement: 'REQUIRED' },
      2: { label: 'Middle', requirement: 'OPTIONAL' },
      3: { label: 'Ottoman', requirement: 'OPTIONAL' },
    },
  },
  '143': {
    confidence: 'UNCONFIRMED',
    notes: 'Not confirmed by Dawson, and this line has 4 piece numbers so it does NOT match the 121/141 pattern. Piece 1 is guessed as the required anchor piece; verify all 4 roles before trusting this line’s numbers.',
    pieces: {
      1: { label: 'Piece 1 (assumed anchor/required)', requirement: 'REQUIRED' },
      2: { label: 'Piece 2 — role unknown', requirement: 'OPTIONAL' },
      3: { label: 'Piece 3 — role unknown', requirement: 'OPTIONAL' },
      4: { label: 'Piece 4 — role unknown', requirement: 'OPTIONAL' },
    },
  },
  '151': {
    confidence: 'UNCONFIRMED',
    notes: 'Dawson’s best guess, not 100% confirmed: -1 reclining corner, -2 non-reclining facing, -3 reclining facing, -4 armless middle, -5 ottoman, -6 wedge. Only piece 1 is treated as required for now (single anchor, like 121’s corner) — verify whether left/right are both needed like the 120/140 lines.',
    pieces: {
      1: { label: 'Reclining corner — assumed anchor', requirement: 'REQUIRED' },
      2: { label: 'Non-reclining facing — assumed', requirement: 'OPTIONAL' },
      3: { label: 'Reclining facing — assumed', requirement: 'OPTIONAL' },
      4: { label: 'Armless middle — assumed', requirement: 'OPTIONAL' },
      5: { label: 'Ottoman — assumed', requirement: 'OPTIONAL' },
      6: { label: 'Wedge — assumed', requirement: 'OPTIONAL' },
    },
  },
  // 126 and 143(TA) appear only in historical sales as discontinued lines
  // Dawson no longer restocks. Kept minimal so history can still be imported.
  '126': {
    confidence: 'UNCONFIRMED',
    notes: 'Discontinued model — Dawson no longer buys this. Rules are a placeholder only, kept so historical sales can be imported.',
    pieces: {
      1: { label: 'Piece 1 (discontinued line, unverified)', requirement: 'REQUIRED' },
      2: { label: 'Piece 2 (discontinued line, unverified)', requirement: 'OPTIONAL' },
      3: { label: 'Piece 3 (discontinued line, unverified)', requirement: 'OPTIONAL' },
      4: { label: 'Piece 4 (discontinued line, unverified)', requirement: 'OPTIONAL' },
    },
  },
};

export function rulesForModel(model) {
  return MODEL_RULES[model] || {
    confidence: 'UNCONFIRMED',
    notes: `No rules defined yet for model ${model}. Treating piece 1 as required and the rest as optional until Dawson/Grant confirm.`,
    pieces: {},
  };
}
