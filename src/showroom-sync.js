// Keeps the public showroom site's per-line stock numbers in sync with real
// Turso inventory. This only ever touches ONE small file — inventory-data.js
// — in the showroom's GitHub repo. It never touches the big photo-laden HTML
// files themselves, so this stays fast, cheap, and can't ever corrupt the
// embedded photos no matter how often it runs.
//
// Each showroom line page (120/121/140/141/142) already has its own
// INVENTORY_<model> object baked in as a fallback; at page load it prefers
// window.LIVE_INVENTORY[model] from inventory-data.js if present, so a sync
// outage (bad token, GitHub down, not configured yet) never breaks the site
// — it just quietly falls back to whatever numbers were last baked in.
//
// 151 is intentionally excluded — that line is custom-order-only and was
// never inventory-tracked on the showroom (Dawson's explicit call).

import { db } from './db.js';
import { presetsForModel } from './preset-seeds.js';
import { MODEL_RULES } from './product-rules.js';

const TRACKED_MODELS = ['120', '121', '140', '141', '142'];

// Showroom color code -> the lowercase key each showroom page's
// INVENTORY_<model> object actually uses (verified against the real files —
// note LG shows up as "grey", not "light grey").
const COLOR_KEY = { WE: 'white', BK: 'black', BE: 'beige', LG: 'grey', KH: 'khaki', TA: 'tan', BL: 'blue', BU: 'blue', OR: 'orange' };

// Ops-app piece label -> the short key each showroom page's per-piece counts
// object uses. Anything not listed here (e.g. the UNCONFIRMED 143/151 labels)
// is deliberately skipped rather than guessed.
const PIECE_KEY = {
  'Left-facing': 'left',
  'Right-facing': 'right',
  'Middle': 'middle',
  'Ottoman': 'ottoman',
  'Wedge': 'wedge',
  'Corner (reversible)': 'corner',
};

// ---------------------------------------------------------------------------
// Showroom config REQUIREMENTS (how many of each piece a named setup needs).
//
// Single source of truth: these counts come straight from PRESET_SEEDS (the
// same presets the ops app uses internally), remapped from piece-number to the
// short piece key each showroom page uses. The public site used to re-type
// these tables by hand in EVERY page (home + each product page), which drifted
// out of sync. Now the sync emits them once into inventory-data.js and every
// page reads from there (falling back to its own baked copy only if the sync
// file is missing).
//
// SHOWROOM_DISPLAY lists the named configs the PUBLIC site shows per line, and
// where each one's counts come from:
//   'Name'                       -> a real seeded preset (counts from PRESET_SEEDS)
//   { name, aliasOf: 'Preset' }  -> a display name that reuses another preset's counts
//   { name, counts: {...} }      -> a display-only config never seeded as its own preset
//
// Two known naming quirks are handled here rather than papered over:
//   * 141 shows the double-ottoman corner setup as "3 Seater with double
//     ottoman"; the seeded preset name is "L with double ottoman" (same counts).
//   * 140 shows a plain "L" (Standard L minus the ottoman) that was never an
//     independently seeded preset. Flag to reconcile with Dawson when convenient.
const SHOWROOM_DISPLAY = {
  '120': ['Big U', 'Small L'],
  '140': ['Standard L', { name: 'L', counts: { left: 1, right: 1, middle: 2, ottoman: 0, wedge: 1 } }, 'Big U', 'Small L'],
  '121': ['Standard L with Ottoman', 'L with double ottoman', 'L', 'Small U', 'Big U', 'Ultra'],
  '141': ['Standard L with Ottoman', { name: '3 Seater with double ottoman', aliasOf: 'L with double ottoman' }, 'L', 'Small U', 'Big U', 'Ultra'],
  '142': ['Standard L with Ottoman'],
};

/** Piece counts for a seeded preset, remapped from piece-number to showroom key. */
function presetCountsForModel(model, name) {
  const rules = (MODEL_RULES[model] || {}).pieces || {};
  const preset = presetsForModel(model).find(p => p.name === name);
  if (!preset) return null;
  const counts = {};
  for (const [num, qty] of Object.entries(preset.pieces)) {
    const key = PIECE_KEY[(rules[num] || {}).label];
    if (key) counts[key] = qty; // unmapped/unconfirmed piece labels are skipped, same as buildLiveInventory
  }
  return counts;
}

/** Per-line, per-config piece requirements for the public showroom, derived from PRESET_SEEDS. */
export function buildConfigRequirements() {
  const out = {};
  for (const [model, list] of Object.entries(SHOWROOM_DISPLAY)) {
    out[model] = {};
    for (const entry of list) {
      if (typeof entry === 'string') out[model][entry] = presetCountsForModel(model, entry);
      else if (entry.aliasOf) out[model][entry.name] = presetCountsForModel(model, entry.aliasOf);
      else out[model][entry.name] = entry.counts;
    }
  }
  return out;
}

/** Real per-model, per-color, per-piece box counts (Dawson + Grant combined), for the 5 showroom-tracked lines only. */
export async function buildLiveInventory() {
  // Bulk-fetch everything up front (3 queries total, not per-product/per-piece)
  // — this runs against the real remote Turso database, so avoiding a
  // round-trip-per-piece-type is the difference between an instant sync and
  // one slow enough to matter on a schedule.
  const placeholders = TRACKED_MODELS.map(() => '?').join(',');
  const products = await db.all(`SELECT * FROM products WHERE model IN (${placeholders}) AND active = 1`, TRACKED_MODELS);
  const productIds = products.map(p => p.id);

  let pieceTypes = [];
  let invRows = [];
  if (productIds.length) {
    const ph2 = productIds.map(() => '?').join(',');
    pieceTypes = await db.all(`SELECT id, product_id, label FROM piece_types WHERE product_id IN (${ph2})`, productIds);
    const pieceTypeIds = pieceTypes.map(pt => pt.id);
    if (pieceTypeIds.length) {
      const ph3 = pieceTypeIds.map(() => '?').join(',');
      invRows = await db.all(`SELECT piece_type_id, quantity FROM inventory WHERE piece_type_id IN (${ph3})`, pieceTypeIds);
    }
  }

  const qtyByPiece = {};
  for (const row of invRows) qtyByPiece[row.piece_type_id] = (qtyByPiece[row.piece_type_id] || 0) + row.quantity;
  const pieceTypesByProduct = {};
  for (const pt of pieceTypes) (pieceTypesByProduct[pt.product_id] ||= []).push(pt);

  const live = {};
  for (const model of TRACKED_MODELS) live[model] = {};
  for (const p of products) {
    const colorKey = COLOR_KEY[p.color];
    if (!colorKey) continue; // unrecognized color code — skip rather than guess
    const counts = {};
    for (const pt of pieceTypesByProduct[p.id] || []) {
      const key = PIECE_KEY[pt.label];
      if (!key) continue; // unconfirmed/unusual piece label — skip rather than guess
      counts[key] = (counts[key] || 0) + (qtyByPiece[pt.id] || 0);
    }
    live[p.model][colorKey] = counts;
  }
  return live;
}

function toJsSource(live, configReqs) {
  return `// Auto-generated by the ops app's showroom sync — do not edit by hand.\n` +
    `// Reflects real Turso inventory as of the timestamp below.\n` +
    `window.LIVE_INVENTORY = ${JSON.stringify(live, null, 2)};\n` +
    `// Per-line config piece requirements, derived from PRESET_SEEDS. Every\n` +
    `// showroom page (home + product pages) reads these instead of hardcoding\n` +
    `// its own copy, so a preset change here propagates everywhere on next sync.\n` +
    `window.LIVE_CONFIG_REQUIREMENTS = ${JSON.stringify(configReqs, null, 2)};\n` +
    `window.LIVE_INVENTORY_SYNCED_AT = ${JSON.stringify(new Date().toISOString())};\n`;
}

let lastSyncAt = 0;
let lastSyncResult = null;

export function getLastSyncStatus() {
  return { lastSyncAt, lastSyncResult };
}

/** Pushes current inventory to the showroom repo's inventory-data.js via GitHub's Contents API (one small file, one commit). */
export async function syncShowroomInventory() {
  const repo = process.env.SHOWROOM_GITHUB_REPO;    // e.g. "yourusername/redefined-couches-showroom"
  const token = process.env.SHOWROOM_GITHUB_TOKEN;  // a GitHub fine-grained PAT, Contents: read/write on that one repo
  const branch = process.env.SHOWROOM_GITHUB_BRANCH || 'main';
  const path = 'inventory-data.js';

  if (!repo || !token) {
    const result = { ok: false, detail: 'Not configured yet — set SHOWROOM_GITHUB_REPO and SHOWROOM_GITHUB_TOKEN in Render’s environment variables.' };
    lastSyncAt = Date.now();
    lastSyncResult = result;
    return result;
  }

  try {
    const live = await buildLiveInventory();
    const configReqs = buildConfigRequirements();
    const content = toJsSource(live, configReqs);
    const apiBase = `https://api.github.com/repos/${repo}/contents/${path}`;
    const headers = {
      Authorization: `Bearer ${token}`,
      Accept: 'application/vnd.github+json',
      'User-Agent': 'redefined-couches-ops-app',
    };

    // Need the current file's sha to update it — GitHub requires this so two
    // concurrent writers can't silently clobber each other.
    let sha;
    const getRes = await fetch(`${apiBase}?ref=${branch}`, { headers });
    if (getRes.status === 200) {
      sha = (await getRes.json()).sha;
    } else if (getRes.status !== 404) {
      throw new Error(`couldn't read current file (HTTP ${getRes.status})`);
    }

    const putRes = await fetch(apiBase, {
      method: 'PUT',
      headers: { ...headers, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        message: 'Auto-sync: update showroom stock from ops app',
        content: Buffer.from(content, 'utf8').toString('base64'),
        branch,
        ...(sha ? { sha } : {}),
      }),
    });

    if (putRes.status === 200 || putRes.status === 201) {
      const colorCount = Object.values(live).reduce((n, m) => n + Object.keys(m).length, 0);
      const result = { ok: true, detail: `Synced ${colorCount} product colors across ${TRACKED_MODELS.length} lines.` };
      lastSyncAt = Date.now();
      lastSyncResult = result;
      return result;
    }
    const body = await putRes.text();
    throw new Error(`GitHub rejected the update (HTTP ${putRes.status}): ${body.slice(0, 200)}`);
  } catch (err) {
    const result = { ok: false, detail: err.message };
    lastSyncAt = Date.now();
    lastSyncResult = result;
    return result;
  }
}
