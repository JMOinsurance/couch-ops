// Color-code -> name (+ search aliases), all confirmed directly by Dawson.

export const COLOR_NAMES = {
  WE: 'White',
  BK: 'Black',
  BE: 'Beige',
  LG: 'Light Grey',
  KH: 'Khaki',
  TA: 'Tan',
  OR: 'Orange',
  BU: 'Blue',   // confirmed same color as BL — two codes ended up used for one color
  BL: 'Blue',
};

// Extra words that should also match a given code when searching (beyond the
// primary display name above) — e.g. "Tan" pieces get called "Brown" too,
// and people spell "Grey"/"Gray" both ways.
export const COLOR_ALIASES = {
  TA: ['Brown'],
  LG: ['Light Gray', 'Gray', 'Grey'],
};

export function colorName(code) {
  return COLOR_NAMES[code] || code;
}

/** True if `query` (case-insensitive) matches this color's code, name, or aliases. */
export function colorMatches(code, query) {
  const q = query.trim().toLowerCase();
  if (!q) return false;
  if (code.toLowerCase().includes(q)) return true;
  const name = COLOR_NAMES[code];
  if (name && name.toLowerCase().includes(q)) return true;
  const aliases = COLOR_ALIASES[code] || [];
  return aliases.some(a => a.toLowerCase().includes(q));
}

/** All searchable terms for a code, lowercased — used to build the client-side search index. */
export function searchTerms(code) {
  const terms = [code.toLowerCase()];
  if (COLOR_NAMES[code]) terms.push(COLOR_NAMES[code].toLowerCase());
  for (const a of COLOR_ALIASES[code] || []) terms.push(a.toLowerCase());
  return terms;
}

// Rough swatch colors for the product-picker tiles — purely visual, not
// authoritative fabric colors.
export const COLOR_SWATCH = {
  WE: '#f2f0ea',
  BK: '#22252a',
  BE: '#cdb392',
  LG: '#b9bec6',
  KH: '#a99a6b',
  TA: '#b98a55',
  OR: '#d97b29',
  BU: '#2b4c7a',
  BL: '#2b4c7a',
};

export function colorSwatch(code) {
  return COLOR_SWATCH[code] || '#c9c4bb';
}

/** A faint tinted-background version of a color's swatch, for cards/tiles — e.g. a light beige wash behind a Beige product's card. Low alpha on purpose so text stays readable. */
export function colorTint(code, alpha = 0.14) {
  const hex = colorSwatch(code).replace('#', '');
  const r = parseInt(hex.slice(0, 2), 16);
  const g = parseInt(hex.slice(2, 4), 16);
  const b = parseInt(hex.slice(4, 6), 16);
  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}
