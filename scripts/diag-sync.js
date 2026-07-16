// Diagnose: does the live site's inventory-data.js match real Turso inventory?
import { buildLiveInventory } from '../src/showroom-sync.js';

const real = await buildLiveInventory();
const resp = await fetch('https://redefinedcouches.com/inventory-data.js?nocache=' + Date.now());
const txt = await resp.text();
const m = txt.match(/window\.LIVE_INVENTORY = (\{[\s\S]*?\});/);
const site = JSON.parse(m[1]);
const ts = txt.match(/LIVE_INVENTORY_SYNCED_AT = "([^"]+)"/);
console.log('site synced at:', ts && ts[1], '| now:', new Date().toISOString());

let diffs = 0;
for (const model of Object.keys(real)) {
  for (const color of Object.keys(real[model])) {
    for (const piece of Object.keys(real[model][color])) {
      const a = real[model][color][piece];
      const b = site[model] && site[model][color] ? (site[model][color][piece] ?? 'MISSING') : 'MISSING';
      if (a !== b) { console.log(`DIFF ${model} ${color} ${piece}: db=${a} site=${b}`); diffs++; }
    }
  }
}
console.log(diffs === 0 ? 'NO DIFFS — site matches database.' : diffs + ' differences.');
process.exit(0);
