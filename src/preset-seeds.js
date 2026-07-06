// Starter presets, seeded once per product on import. All of these are
// Dawson's real, named configurations.
//
// Corner family (121, 141, 142) — piece 1 = corner, 2 = middle, 3 = ottoman.
// Renamed 2026-07 per Dawson: Costco U -> Small U, the old "L" (1 ottoman)
// -> Standard L with Ottoman, and "L with 0 ottoman" -> plain "L". "L with
// double ottoman" is still a placeholder name pending a better one.
//   Small L:                  corner x3, middle x1, ottoman x1  (5 pieces)
//   Standard L with Ottoman:  corner x3, middle x2, ottoman x1  (6 pieces)
//   L with double ottoman:    corner x3, middle x2, ottoman x2  (7 pieces) — name TBD, see below
//   L:                        corner x3, middle x2               (5 pieces)
//   Small U:                  corner x2, middle x3, ottoman x1  (6 pieces)
//   Big U:                     corner x2, middle x2, ottoman x2  (6 pieces)
//   Ultra:                      corner x2, middle x4, ottoman x2  (8 pieces)
//
//   Plus 3 smaller setups added per Dawson (2026-07): loveseat/couch/chaise
//   sized options he doesn't sell often but wants listed. Dawson confirmed
//   "add them" but said to rank them last since they're low-volume. Piece
//   counts here are NOT independently confirmed the way the 7 above are —
//   they're a reasonable guess (2 corners cap a straight run with no bend,
//   same idea as the supplier's own smallest listings) pending his review.
// Facing family — 120 (pieces 2=left,3=right,4=middle,5=ottoman,6=wedge):
//   Small L:    left x1, right x1, middle x1, ottoman x1, wedge x1  (5)
//   Standard L: left x1, right x1, middle x2, ottoman x1, wedge x1  (6)
//   Big U:      left x1, right x1, middle x2, ottoman x2            (6)
//
// Facing family — 140 (pieces 1=left,2=right,3=middle,4=ottoman,5=wedge):
//   Small L:    left x1, right x1, middle x1, ottoman x1, wedge x1  (5)
//   Standard L: left x1, right x1, middle x2, ottoman x1, wedge x1  (6)
//   Big U:      left x1, right x1, middle x2, ottoman x2            (6)
//
// Recliner family (151): Dawson's call — this line gets sold too many
// different ways to name as presets ("we can really sell them any which
// way"). Left with NO starter presets on purpose; it's custom-entry only.
// The piece-role guesses from earlier (reclining corner / non-reclining
// facing / reclining facing / armless middle / ottoman / wedge) are still
// what's in product-rules.js and still what the custom entry screen shows,
// since collapsing them into fewer buckets would mean merging separately
//-tracked inventory counts — flagged in the app, not simplified blind.

export const PRESET_SEEDS = {
  CORNER_FAMILY: [
    { name: 'Small L', pieces: { 1: 3, 2: 1, 3: 1 } },
    { name: 'Standard L with Ottoman', pieces: { 1: 3, 2: 2, 3: 1 } },
    { name: 'L with double ottoman', pieces: { 1: 3, 2: 2, 3: 2 } }, // name TBD — see preset-seeds.js header note
    { name: 'L', pieces: { 1: 3, 2: 2, 3: 0 } },
    { name: 'Small U', pieces: { 1: 2, 2: 3, 3: 1 } },
    { name: 'Big U', pieces: { 1: 2, 2: 2, 3: 2 } },
    { name: 'Ultra', pieces: { 1: 2, 2: 4, 3: 2 } },
    // --- Smaller, low-volume setups (added 2026-07, ranked last on purpose) ---
    { name: 'Loveseat', pieces: { 1: 2 } },
    { name: '3-Seat Couch', pieces: { 1: 2, 2: 1 } },
    { name: 'Chaise', pieces: { 1: 2, 3: 1 } },
  ],
  FACING_FAMILY_120: [
    { name: 'Small L', pieces: { 2: 1, 3: 1, 4: 1, 5: 1, 6: 1 } },
    { name: 'Standard L', pieces: { 2: 1, 3: 1, 4: 2, 5: 1, 6: 1 } },
    { name: 'Big U', pieces: { 2: 1, 3: 1, 4: 2, 5: 2 } },
  ],
  FACING_FAMILY_140: [
    { name: 'Small L', pieces: { 1: 1, 2: 1, 3: 1, 4: 1, 5: 1 } },
    { name: 'Standard L', pieces: { 1: 1, 2: 1, 3: 2, 4: 1, 5: 1 } },
    { name: 'Big U', pieces: { 1: 1, 2: 1, 3: 2, 4: 2 } },
  ],
  RECLINER_FAMILY_151: [],
};

export function presetsForModel(model) {
  if (model === '121' || model === '141' || model === '142') return PRESET_SEEDS.CORNER_FAMILY;
  if (model === '120') return PRESET_SEEDS.FACING_FAMILY_120;
  if (model === '140') return PRESET_SEEDS.FACING_FAMILY_140;
  if (model === '151') return PRESET_SEEDS.RECLINER_FAMILY_151;
  return [];
}
