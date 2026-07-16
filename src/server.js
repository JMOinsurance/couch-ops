import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { URL } from 'node:url';

import { db } from './db.js';
import { ensureUser, findUserByName, createSession, getSessionUser, destroySession, parseCookies } from './auth.js';
import { layout, loginPage, esc, money } from './views.js';
import { allProductsAvailability } from './configurator.js';
import { piecesForProduct, presetsForProduct, presetById, totalOnHandForProduct } from './sale-logic.js';
import { activeProductSummaries } from './product-summary.js';
import { colorName, colorSwatch, colorTint } from './colors.js';
import { suggestedPrice } from './pricing.js';
import { suggestedUnitCost, avgCostPerBox, ONLINE_ORDER_COST_PER_BOX, ORDER_PIECE_COST_SHIPPED } from './cost.js';
import { partnerEarnings } from './payout.js';
import { barChart, pieChart } from './charts.js';
import {
  avgSalePrice, bestSellers, salesByModel, salesByColor, perTripStats,
  timeInBusiness, profitSummary, enteredByBreakdown, expectedInventoryValue, recentSales,
} from './stats.js';
import { syncShowroomInventory, getLastSyncStatus } from './showroom-sync.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.join(__dirname, '..', 'public');
const UPLOADS_DIR = path.join(__dirname, '..', 'data', 'uploads', 'trip-photos');
if (!fs.existsSync(UPLOADS_DIR)) fs.mkdirSync(UPLOADS_DIR, { recursive: true });
const PORT = process.env.PORT || 3000;

await ensureUser('Dawson');
await ensureUser('Grant');

// Keep the public showroom's stock numbers synced automatically — a first
// attempt shortly after startup (so a fresh deploy/restart is current right
// away), then every hour after that. Silently a no-op until the showroom
// GitHub repo + token are configured (see showroom-sync.js).
setTimeout(() => { syncShowroomInventory().catch(() => {}); }, 15_000);
setInterval(() => { syncShowroomInventory().catch(() => {}); }, 60 * 60 * 1000);

// --- tiny helpers ------------------------------------------------------------
function sendHtml(res, status, html) {
  res.writeHead(status, { 'Content-Type': 'text/html; charset=utf-8' });
  res.end(html);
}
function redirect(res, location) {
  res.writeHead(302, { Location: location });
  res.end();
}
async function readBody(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  return Buffer.concat(chunks).toString('utf8');
}
async function readForm(req) {
  const body = await readBody(req);
  return Object.fromEntries(new URLSearchParams(body));
}
function serveStatic(req, res, pathname) {
  const filePath = path.join(PUBLIC_DIR, pathname);
  if (!filePath.startsWith(PUBLIC_DIR)) { res.writeHead(403); res.end(); return true; }
  if (!fs.existsSync(filePath) || fs.statSync(filePath).isDirectory()) return false;
  const ext = path.extname(filePath);
  const type = { '.css': 'text/css', '.js': 'application/javascript', '.svg': 'image/svg+xml', '.png': 'image/png', '.json': 'application/manifest+json' }[ext] || 'application/octet-stream';
  res.writeHead(200, { 'Content-Type': type });
  fs.createReadStream(filePath).pipe(res);
  return true;
}
async function currentUser(req) {
  const cookies = parseCookies(req);
  return getSessionUser(cookies.session);
}
function today() {
  return new Date().toISOString().slice(0, 10);
}

// --- reusable button-group control -------------------------------------------
function buttonGroup(name, options, { selected } = {}) {
  return `<div class="btn-group">
    ${options.map((opt, i) => {
      const value = typeof opt === 'string' ? opt : opt.value;
      const label = typeof opt === 'string' ? opt : opt.label;
      const id = `${name}_${i}`;
      const checked = selected ? selected === value : i === 0;
      return `<input type="radio" name="${esc(name)}" id="${id}" value="${esc(value)}" ${checked ? 'checked' : ''}>
              <label for="${id}">${esc(label)}</label>`;
    }).join('')}
  </div>`;
}

// =============================================================================
// HOME PAGE — product picker for logging a sale. This is the landing page.
// =============================================================================
// Renders the per-piece Dawson/Grant stock rows for a product's expandable
// breakdown. Whoever holds more of a given piece gets the green "lead"
// highlight; a zero count is dimmed. Shared by the home and dashboard tiles.
function stockBreakdownRows(pieces) {
  return pieces.map(pt => {
    const d = pt.byLocation.Dawson, g = pt.byLocation.Grant;
    return `
          <div class="stock-breakdown-row">
            <span class="sb-piece">${esc(pt.label)}</span>
            <span class="sb-counts"><span class="sb-owner${d > g ? ' lead' : ''}${d === 0 ? ' zero' : ''}"><span class="sb-name">Dawson</span><span class="sb-num">${d}</span></span><span class="sb-owner${g > d ? ' lead' : ''}${g === 0 ? ' zero' : ''}"><span class="sb-name">Grant</span><span class="sb-num">${g}</span></span></span>
          </div>`;
  }).join('');
}

async function handleHome(req, res, user) {
  // In-stock products first, out-of-stock ones pushed to the end (still
  // shown, just deprioritized) — sort is stable so the existing model/color
  // order is preserved within each group.
  const products = (await activeProductSummaries()).slice().sort((a, b) => (a.total === 0) - (b.total === 0));

  const body = `
  <h1 class="mt0">What are you selling, ${esc(user.name)}?</h1>
  <input type="text" class="search-box" id="product-search" placeholder="Search — e.g. &quot;120BE&quot; or &quot;Beige&quot;" autofocus>
  <div class="product-grid" id="product-grid">
    ${products.map(p => `
      <a class="product-tile ${p.total === 0 ? 'out-of-stock' : ''}" href="/sale/${p.id}" style="background:${colorTint(p.color, 0.16)};border-color:${colorSwatch(p.color)}55;" data-sku="${esc(p.sku.toLowerCase())}" data-color="${esc(p.colorSearchTerms)}" data-code="${esc(p.color.toLowerCase())}">
        <div class="swatch" style="background:${p.swatch}"></div>
        <div class="sku">${esc(p.sku)}</div>
        <div class="colorname">${esc(p.colorName)}</div>
        <div class="stock ${p.total === 0 ? 'out' : p.total <= 2 ? 'low' : ''}" onclick="toggleStock(event, 'home_${p.id}')">${p.total} box${p.total === 1 ? '' : 'es'} on hand ▾</div>
        <div class="stock-breakdown" id="breakdown_home_${p.id}">
          ${stockBreakdownRows(p.pieces)}
        </div>
      </a>
    `).join('')}
  </div>
  <p class="small muted" id="no-results" style="display:none;">No products match that search.</p>

  <script>
    const search = document.getElementById('product-search');
    const tiles = Array.from(document.querySelectorAll('.product-tile'));
    const noResults = document.getElementById('no-results');
    search.addEventListener('input', () => {
      const q = search.value.trim().toLowerCase();
      let shown = 0;
      for (const tile of tiles) {
        const match = !q || tile.dataset.sku.includes(q) || tile.dataset.color.includes(q) || tile.dataset.code.includes(q);
        tile.style.display = match ? '' : 'none';
        if (match) shown++;
      }
      noResults.style.display = shown === 0 ? 'block' : 'none';
    });
    function toggleStock(ev, id) {
      ev.preventDefault();
      ev.stopPropagation();
      const el = document.getElementById('breakdown_' + id);
      if (el) el.classList.toggle('open');
    }
  </script>
  `;
  sendHtml(res, 200, layout({ title: 'Log a sale', user, active: '/', body, wide: true }));
}

// =============================================================================
// SALE STEP 2 — pick a preset or "custom" for the chosen product.
// =============================================================================
async function handleSaleProduct(req, res, user, productId) {
  const product = await db.get(`SELECT * FROM products WHERE id = ?`, [productId]);
  if (!product) return sendHtml(res, 404, layout({ title: 'Not found', user, active: '/', body: '<p>Product not found.</p>' }));

  // Buildable presets first, ones you can't currently make pushed to the
  // end (still shown, just greyed and labeled with what's short).
  const presets = (await presetsForProduct(productId)).slice().sort((a, b) => (a.maxAvailable === 0) - (b.maxAvailable === 0));
  const total = await totalOnHandForProduct(productId);
  const pieces = await piecesForProduct(productId);

  const body = `
  <a class="back-link" href="/">&larr; Back to products</a>
  <h1 class="mt0">${esc(product.sku)} — ${esc(colorName(product.color))}</h1>
  <p class="muted">${total} box${total === 1 ? '' : 'es'} on hand total (Dawson + Grant).</p>
  ${product.rules_confidence === 'UNCONFIRMED' ? `<div class="notice">Piece rules for this line aren't fully confirmed yet — double check the pieces on the confirm screen before saving.</div>` : ''}

  <div class="choice-grid">
    ${presets.map(preset => {
      const totalPieces = preset.items.reduce((s, i) => s + i.quantity, 0);
      const suggested = suggestedPrice(totalPieces);
      const unavailable = preset.maxAvailable === 0;
      return `
      <a class="choice-card ${unavailable ? 'unavailable-card' : ''}" href="/sale/${productId}/confirm?preset=${preset.id}">
        <div class="name">${esc(preset.name)}</div>
        <div class="detail">${preset.items.map(i => `${i.quantity}× ${esc(i.label)}`).join(', ')}</div>
        ${suggested ? `<div class="detail" style="margin-top:.4rem;"><strong>Suggested: ${money(suggested)}</strong> <span class="muted">(${totalPieces} pieces)</span></div>` : ''}
        ${!unavailable
          ? `<div class="detail" style="margin-top:.3rem;">Can build ${preset.maxAvailable} right now</div>`
          : `<div class="unavailable">Not enough in stock right now</div>
             <div class="detail" style="margin-top:.3rem;">Missing: ${preset.missing.map(m => `${m.short} more ${esc(m.label)} (have ${m.have}, need ${m.need})`).join(', ')}</div>`}
        ${preset.is_starter_guess ? `<div class="detail" style="margin-top:.3rem;">⚠️ starter guess — check before using</div>` : ''}
      </a>
    `;
    }).join('')}
    <a class="choice-card custom" href="/sale/${productId}/confirm?custom=1">+ Custom / something else</a>
  </div>

  <h2>Inventory for ${esc(product.sku)}</h2>
  <div class="card" style="background:${colorTint(product.color)};border-color:${colorSwatch(product.color)}4d;">
    <table>
      <thead><tr><th>Piece</th><th>Dawson</th><th>Grant</th><th>Total</th></tr></thead>
      <tbody>
        ${pieces.map(pt => `
          <tr>
            <td data-label="Piece">${esc(pt.label)} <span class="small muted">${esc(pt.full_sku)}</span></td>
            <td data-label="Dawson">${pt.byLocation.Dawson}</td>
            <td data-label="Grant">${pt.byLocation.Grant}</td>
            <td data-label="Total"><span class="pill ${pt.total === 0 ? 'bad' : pt.total <= 1 ? 'warn' : 'good'}">${pt.total}</span></td>
          </tr>`).join('')}
      </tbody>
    </table>
  </div>
  `;
  sendHtml(res, 200, layout({ title: product.sku, user, active: '/', body, wide: true }));
}

// =============================================================================
// SALE STEP 3 — confirm pieces + enter price/payment, then submit.
// =============================================================================
async function handleSaleConfirm(req, res, user, productId, query) {
  const product = await db.get(`SELECT * FROM products WHERE id = ?`, [productId]);
  if (!product) return sendHtml(res, 404, layout({ title: 'Not found', user, active: '/', body: '<p>Product not found.</p>' }));

  const isCustom = query.get('custom') === '1';
  const presetId = query.get('preset');

  let pieceFieldsHtml = '';
  let headerNote = '';
  let priceHintHtml = '';
  let priceInputExtra = '';

  if (isCustom) {
    const pieces = await piecesForProduct(productId);
    headerNote = 'Tap + / − for each piece this couch uses.';
    pieceFieldsHtml = pieces.map(pt => `
      <div class="stepper-row">
        <div class="info">
          <div class="piece-label">${esc(pt.label)}</div>
          <div class="piece-stock">${pt.full_sku} · D:${pt.byLocation.Dawson} / G:${pt.byLocation.Grant}</div>
        </div>
        <div class="stepper" data-piece="${pt.id}">
          <button type="button" class="minus" onclick="step(${pt.id}, -1)">−</button>
          <span class="qty" id="qty_${pt.id}">0</span>
          <button type="button" class="plus" onclick="step(${pt.id}, 1)">+</button>
          <input type="hidden" name="piece_${pt.id}" id="input_${pt.id}" value="0">
        </div>
      </div>
    `).join('');
    pieceFieldsHtml += `
      <div class="field-block">
        <label class="field-label">Save this as a preset for next time? (optional)</label>
        <input type="text" name="save_preset_name" placeholder="e.g. Costco U">
      </div>
      <script>
        const PRICE_TABLE = ${JSON.stringify({ 5: 1100, 6: 1300, 7: 1500, 8: 1750 })};
        function updatePriceHint() {
          const inputs = document.querySelectorAll('[id^="input_"]');
          let total = 0;
          inputs.forEach(i => total += parseInt(i.value, 10) || 0);
          const hint = document.getElementById('price-hint');
          const suggested = PRICE_TABLE[total];
          hint.textContent = suggested ? ('Suggested: $' + suggested.toLocaleString() + ' for ' + total + ' pieces (just a starting point — adjust for discounts).') : (total > 0 ? (total + ' pieces total — no standard suggestion for that count.') : '');
        }
        function step(id, delta) {
          const input = document.getElementById('input_' + id);
          const span = document.getElementById('qty_' + id);
          const next = Math.max(0, parseInt(input.value, 10) + delta);
          input.value = next;
          span.textContent = next;
          updatePriceHint();
        }
      </script>
    `;
    priceHintHtml = `<p class="small muted" id="price-hint"></p>`;
  } else {
    const preset = await presetById(presetId);
    if (!preset) return redirect(res, `/sale/${productId}`);
    const allPieces = await piecesForProduct(productId);
    const stockById = Object.fromEntries(allPieces.map(pt => [pt.id, pt.byLocation]));
    headerNote = `Using the "${esc(preset.name)}" preset — tap +/− if you need to adjust it for this sale.`;
    pieceFieldsHtml = `
      <div class="card">
        ${preset.items.map(i => {
          const stock = stockById[i.piece_type_id] || { Dawson: 0, Grant: 0 };
          return `
          <div class="stepper-row">
            <div class="info">
              <div class="piece-label">${esc(i.label)}</div>
              <div class="piece-stock">${esc(i.full_sku)} · D:${stock.Dawson} / G:${stock.Grant}</div>
            </div>
            <div class="stepper" data-piece="${i.piece_type_id}">
              <button type="button" class="minus" onclick="step(${i.piece_type_id}, -1)">−</button>
              <span class="qty" id="qty_${i.piece_type_id}">${i.quantity}</span>
              <button type="button" class="plus" onclick="step(${i.piece_type_id}, 1)">+</button>
              <input type="hidden" name="piece_${i.piece_type_id}" id="input_${i.piece_type_id}" value="${i.quantity}">
            </div>
          </div>
        `;
        }).join('')}
      </div>
      <p class="small"><a href="/sale/${productId}/confirm?custom=1">Not quite right? Switch to custom &rarr;</a></p>
      <script>
        const PRICE_TABLE = ${JSON.stringify({ 5: 1100, 6: 1300, 7: 1500, 8: 1750 })};
        function updatePriceHint() {
          const inputs = document.querySelectorAll('[id^="input_"]');
          let total = 0;
          inputs.forEach(i => total += parseInt(i.value, 10) || 0);
          const hint = document.getElementById('price-hint');
          if (!hint) return;
          const suggested = PRICE_TABLE[total];
          hint.textContent = suggested ? ('Suggested: $' + suggested.toLocaleString() + ' for ' + total + ' pieces (just a starting point — adjust for discounts).') : (total > 0 ? (total + ' pieces total — no standard suggestion for that count.') : '');
        }
        function step(id, delta) {
          const input = document.getElementById('input_' + id);
          const span = document.getElementById('qty_' + id);
          const next = Math.max(0, parseInt(input.value, 10) + delta);
          input.value = next;
          span.textContent = next;
          updatePriceHint();
        }
      </script>
    `;
    const totalPieces = preset.items.reduce((s, i) => s + i.quantity, 0);
    const suggested = suggestedPrice(totalPieces);
    if (suggested) {
      priceInputExtra = `value="${suggested}"`;
    }
    priceHintHtml = `<p class="small muted" id="price-hint">${suggested ? `Suggested: ${money(suggested)} for ${totalPieces} pieces — just a starting point, change it for discounts or anything else.` : ''}</p>`;
  }

  const body = `
  <a class="back-link" href="/sale/${productId}">&larr; Back to ${esc(product.sku)} options</a>
  <h1 class="mt0">${esc(product.sku)} sale</h1>
  <p class="muted">${headerNote}</p>

  <form method="post" action="/sale/${productId}">
    <h2 class="mt0">Payment status</h2>
    <div class="field-block">
      ${buttonGroup('payment_status', ['Paid', { value: 'Deposit', label: 'Deposit — pay on delivery' }])}
    </div>
    <div id="deposit-block" style="display:none;">
      <div class="notice" style="background:#fdf3e0;border-color:#f0dcb0;color:#7a5a17;">
        <strong>Deposit hold.</strong> The pieces get held for this customer right away — inventory and the website will show them as gone. It counts as money made only when you complete it from the <strong>Deposits</strong> tab (delivery day).
      </div>
      <div class="field-block">
        <label class="field-label">Deposit amount ($ — usually $100, change it if not)</label>
        <input type="number" name="deposit_amount" min="0" step="1" value="100" inputmode="numeric" id="deposit-amount-input">
      </div>
      <div class="field-block">
        <label class="field-label">Customer name (so you know whose couch this is)</label>
        <input type="text" name="customer_name">
      </div>
      <div class="field-block">
        <label class="field-label">Location of pickup/delivery</label>
        <input type="text" name="delivery_location" placeholder="e.g. Festus warehouse pickup, or their address">
      </div>
      <div class="field-block">
        <label class="field-label">Delivery date (if you already know it — can be set later on the Deposits tab)</label>
        <input type="date" name="delivery_date">
      </div>
    </div>

    <h2>Pieces</h2>
    ${pieceFieldsHtml}

    <h2>Whose inventory is this coming from?</h2>
    <div class="field-block">
      ${buttonGroup('fulfilled_from', ['Dawson', 'Grant'])}
    </div>

    <h2>Price</h2>
    <div class="field-block">
      <label class="field-label">Couch price ($)</label>
      <input type="number" name="base_price" id="base-price-input" min="0" step="1" required inputmode="numeric" ${priceInputExtra}>
      ${priceHintHtml}
    </div>
    <div class="field-block">
      <label class="field-label">Delivery — who's doing it?</label>
      ${buttonGroup('delivery_by', [{ value: '', label: 'No delivery' }, 'Dawson', 'Grant', 'Both'])}
      <label class="field-label" style="margin-top:.6rem;">Delivery fee ($ — assumes $100 once someone's picked)</label>
      <input type="number" name="delivery_fee" id="delivery-fee-input" min="0" step="1" value="0" inputmode="numeric">
    </div>
    <div class="field-block">
      <label class="field-label">Assembly — who's doing it?</label>
      ${buttonGroup('assembly_by', [{ value: '', label: 'No assembly' }, 'Dawson', 'Grant', 'Both'])}
      <label class="field-label" style="margin-top:.6rem;">Assembly fee ($ — assumes $100 once someone's picked)</label>
      <input type="number" name="assembly_fee" id="assembly-fee-input" min="0" step="1" value="0" inputmode="numeric">
    </div>
    <div class="notice" id="total-line" style="background:#e9f0fa;border-color:#c4d7f2;color:#1d4f91;font-weight:600;">Total: —</div>

    <h2>Paid how?</h2>
    <div class="field-block">
      ${buttonGroup('payment_method', ['Cash', 'Venmo', 'Other'])}
    </div>
    <div class="field-block">
      <label class="field-label">Date (assumed today)</label>
      <input type="date" name="date" value="${today()}" required>
    </div>

    <button type="submit" class="big-submit" id="sale-submit-btn">Log this sale</button>
  </form>
  <script>
    (function() {
      const block = document.getElementById('deposit-block');
      const btn = document.getElementById('sale-submit-btn');
      const base = document.getElementById('base-price-input');
      const dFee = document.getElementById('delivery-fee-input');
      const aFee = document.getElementById('assembly-fee-input');
      const totalLine = document.getElementById('total-line');
      const depAmt = document.getElementById('deposit-amount-input');

      function isDeposit() {
        const sel = document.querySelector('input[name="payment_status"]:checked');
        return sel && sel.value === 'Deposit';
      }
      function fmt(n) { return '$' + (n || 0).toLocaleString(); }
      function updateTotal() {
        const b = parseFloat(base.value) || 0;
        const d = parseFloat(dFee.value) || 0;
        const a = parseFloat(aFee.value) || 0;
        const total = b + d + a;
        let text = 'Total: ' + fmt(total);
        const parts = [];
        if (d > 0) parts.push(fmt(d) + ' delivery');
        if (a > 0) parts.push(fmt(a) + ' assembly');
        if (parts.length) text += ' (' + fmt(b) + ' couch + ' + parts.join(' + ') + ')';
        if (isDeposit()) {
          const dep = parseFloat(depAmt.value) || 0;
          text += ' — ' + fmt(dep) + ' now, ' + fmt(Math.max(0, total - dep)) + ' due on delivery';
        }
        totalLine.textContent = text;
      }
      // Delivery/assembly: picking a person assumes a $100 fee (still editable);
      // "No delivery/assembly" zeroes it back out.
      function wireFee(radioName, feeInput) {
        document.querySelectorAll('input[name="' + radioName + '"]').forEach(r => {
          r.addEventListener('change', () => {
            if (!r.checked) return;
            if (r.value === '') feeInput.value = 0;
            else if (!(parseFloat(feeInput.value) > 0)) feeInput.value = 100;
            updateTotal();
          });
        });
      }
      wireFee('delivery_by', dFee);
      wireFee('assembly_by', aFee);
      document.querySelectorAll('input[name="payment_status"]').forEach(r => {
        r.addEventListener('change', () => {
          const isDep = isDeposit();
          block.style.display = isDep ? '' : 'none';
          btn.textContent = isDep ? 'Log deposit & hold the pieces' : 'Log this sale';
          updateTotal();
        });
      });
      [base, dFee, aFee, depAmt].forEach(el => el.addEventListener('input', updateTotal));
      updateTotal();
    })();
  </script>
  `;
  sendHtml(res, 200, layout({ title: `${product.sku} sale`, user, active: '/', body, wide: true }));
}

// Renders the "inventory went down" confirmation table: every piece this sale
// touched, with before → after counts at the fulfilling location (and the
// combined total), so what just happened to stock is visible at a glance.
function inventoryChangeCard(changes, location) {
  if (!changes.length) return '';
  return `
    <div class="card">
      <strong>📦 Inventory updated — here's what moved (from ${esc(location)}'s stock)</strong>
      <table style="margin-top:.6rem;">
        <thead><tr><th>Piece</th><th>Was</th><th>Now</th><th>Total left (D+G)</th></tr></thead>
        <tbody>
          ${changes.map(c => `
            <tr>
              <td data-label="Piece">${esc(c.label)}${c.backordered ? ` <span class="pill warn">${c.backordered} on order</span>` : ''}</td>
              <td data-label="Was">${c.before}</td>
              <td data-label="Now"><span class="pill ${c.after === 0 ? 'bad' : c.after <= 1 ? 'warn' : 'good'}">${c.after}</span> <span class="small muted">−${c.taken}</span></td>
              <td data-label="Total left">${c.totalAfter}</td>
            </tr>`).join('')}
        </tbody>
      </table>
    </div>`;
}

// The latest-trip P&L card shown right after a sale: what the trip cost,
// how many sets it's sold so far, and where its running profit stands.
async function latestTripCard() {
  const trips = await perTripStats();
  if (!trips.length) return '';
  const t = trips[trips.length - 1];
  return `
    <div class="card">
      <strong>🚚 ${t.trip_number != null ? 'Trip ' + t.trip_number : 'Latest trip'} — running total (this sale counts toward it)</strong>
      <div class="stat-grid" style="margin-top:.6rem;margin-bottom:0;">
        <div class="stat-card bad"><div class="label">Trip cost</div><div class="value">${money(t.total_cost + (t.gas_cost || 0))}</div><div class="small muted">${t.boxes_actual} boxes${t.gas_cost ? ` incl. ${money(t.gas_cost)} gas` : ''}</div></div>
        <div class="stat-card"><div class="label">Sets sold from it</div><div class="value">${t.setsSold}</div></div>
        <div class="stat-card"><div class="label">Gross sales from it</div><div class="value">${money(t.grossSales)}</div></div>
        <div class="stat-card ${t.netProfit >= 0 ? 'good' : 'bad'}"><div class="label">Trip profit so far</div><div class="value">${money(t.netProfit)}</div></div>
      </div>
    </div>`;
}

async function handleSaleSubmit(req, res, user, productId) {
  const form = await readForm(req);
  const pieces = await piecesForProduct(productId);
  const location = form.fulfilled_from;
  const isDepositHold = form.payment_status === 'Deposit';

  const pieceQty = {};
  let piecesTotal = 0;
  const shortfalls = [];
  for (const pt of pieces) {
    const qty = parseInt(form[`piece_${pt.id}`] || '0', 10) || 0;
    if (qty > 0) {
      pieceQty[pt.id] = qty;
      piecesTotal += qty;
      const onHand = pt.byLocation[location] || 0;
      if (qty > onHand) {
        const other = location === 'Dawson' ? 'Grant' : 'Dawson';
        shortfalls.push({ pt, need: qty, have: onHand, short: qty - onHand, otherHas: pt.byLocation[other] || 0, otherName: other });
      }
    }
  }

  if (piecesTotal === 0) {
    const body = `
      <a class="back-link" href="/sale/${productId}">&larr; Back</a>
      <div class="notice bad"><strong>Couldn't log that sale:</strong><br>No pieces were selected for this sale.</div>
      <p><a href="/sale/${productId}">Try again</a></p>
    `;
    return sendHtml(res, 200, layout({ title: 'Sale not saved', user, active: '/', body }));
  }

  // ---- Oversell: selling more pieces than are on hand is allowed, but each
  // short piece needs a decision — order it (~$215/box shipped) or grab it on
  // the next trip. First pass renders that decision screen; the re-submit
  // comes back with oversell_resolved=1 and a resolve_<pieceId> choice each.
  if (shortfalls.length && form.oversell_resolved !== '1') {
    const product = await db.get(`SELECT * FROM products WHERE id = ?`, [productId]);
    const passThrough = Object.entries(form)
      .map(([k, v]) => `<input type="hidden" name="${esc(k)}" value="${esc(v)}">`).join('\n');
    const body = `
    <a class="back-link" href="/sale/${productId}">&larr; Back to ${esc(product.sku)} options</a>
    <h1 class="mt0">Not enough in stock — how do you want to cover it?</h1>
    <p class="muted">You're selling more pieces than ${esc(location)} has on hand. Pick how each missing piece gets covered — the sale still logs now, and the missing pieces get tracked on the <strong>Deposits &amp; Orders</strong> tab until they're in. Default assumes the customer's waiting on the next trip.</p>
    <form method="post" action="/sale/${productId}">
      ${passThrough}
      <input type="hidden" name="oversell_resolved" value="1">
      <div class="card">
        ${shortfalls.map(s => `
          <div class="field-block">
            <label class="field-label">${esc(s.pt.label)} — need ${s.need}, ${esc(location)} has ${s.have} (short ${s.short})${s.otherHas > 0 ? ` · FYI: ${esc(s.otherName)} has ${s.otherHas} if you'd rather switch who fulfills` : ''}</label>
            <select name="resolve_${s.pt.id}" style="width:100%;padding:.8rem .9rem;font-size:1.1rem;border:2px solid var(--line);border-radius:12px;">
              <option value="next_trip">Customer's waiting on the next trip to get ${s.short > 1 ? 'them' : 'it'}</option>
              <option value="order">Order the piece${s.short > 1 ? 's' : ''} — ${money(ORDER_PIECE_COST_SHIPPED)}/box shipped</option>
            </select>
          </div>
        `).join('')}
      </div>
      <button type="submit" class="big-submit">Log the sale with this plan</button>
    </form>
    `;
    return sendHtml(res, 200, layout({ title: 'Cover the missing pieces', user, active: '/', body, wide: true }));
  }

  const priorProfit = (await profitSummary()).totalProfit;

  // Every new sale is assumed to come from the most recent trip, so the
  // Dashboard's per-trip profit keeps itself up to date automatically.
  const latestTrip = await db.get(`SELECT id FROM trips ORDER BY date DESC, id DESC LIMIT 1`);
  const depositAmount = isDepositHold ? (parseFloat(form.deposit_amount || '0') || 100) : parseFloat(form.deposit_amount || '0');

  const info = await db.run(`
    INSERT INTO sales (date, product_id, trip_id, pieces_total, base_price, delivery_fee, delivery_by, assembly_fee, assembly_by, payment_method, payment_status, deposit_amount, customer_name, delivery_location, delivery_date, entered_by, is_historical, is_deposit_hold)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?)
  `, [
    form.date, productId, latestTrip ? latestTrip.id : null, piecesTotal, parseFloat(form.base_price || '0'), parseFloat(form.delivery_fee || '0'),
    form.delivery_by || null, parseFloat(form.assembly_fee || '0'), form.assembly_by || null,
    form.payment_method, form.payment_status, depositAmount,
    form.customer_name || null, form.delivery_location || null, form.delivery_date || null,
    user.name, isDepositHold ? 1 : 0
  ]);
  const saleId = info.lastInsertRowid;

  // Decrement what's actually there (never below 0); anything short becomes a
  // piece_orders row with the fulfillment choice made above. sale_items only
  // records what really came out of stock, so deleting/cancelling the sale
  // puts back exactly what was taken.
  const changes = [];
  const orderRows = [];
  for (const pt of pieces) {
    const qty = pieceQty[pt.id];
    if (!qty) continue;
    const onHand = pt.byLocation[location] || 0;
    const take = Math.min(qty, onHand);
    const short = qty - take;
    if (take > 0) {
      await db.run(`INSERT INTO sale_items (sale_id, piece_type_id, location, quantity) VALUES (?, ?, ?, ?)`,
        [saleId, pt.id, location, take]);
      await db.run(`UPDATE inventory SET quantity = quantity - ? WHERE piece_type_id = ? AND location = ?`,
        [take, pt.id, location]);
    }
    if (short > 0) {
      // Default to waiting on the next trip — ordering ($215/box shipped) only
      // happens when explicitly picked.
      const fulfillment = form[`resolve_${pt.id}`] === 'order' ? 'order' : 'next_trip';
      await db.run(`
        INSERT INTO piece_orders (sale_id, piece_type_id, location, quantity, fulfillment, unit_cost, status, entered_by, notes)
        VALUES (?, ?, ?, ?, ?, ?, 'open', ?, ?)
      `, [saleId, pt.id, location, short, fulfillment, fulfillment === 'order' ? ORDER_PIECE_COST_SHIPPED : 0, user.name,
          `Oversold on sale #${saleId}`]);
      orderRows.push({ label: pt.label, qty: short, fulfillment });
    }
    const otherLoc = location === 'Dawson' ? 'Grant' : 'Dawson';
    changes.push({
      label: pt.label, taken: take, before: onHand, after: onHand - take, backordered: short,
      totalAfter: (onHand - take) + (pt.byLocation[otherLoc] || 0),
    });
  }

  if (form.save_preset_name && form.save_preset_name.trim()) {
    const presetInfo = await db.run(`INSERT INTO presets (product_id, name, is_starter_guess) VALUES (?, ?, 0)`,
      [productId, form.save_preset_name.trim()]);
    for (const [pieceTypeId, qty] of Object.entries(pieceQty)) {
      await db.run(`INSERT INTO preset_items (preset_id, piece_type_id, quantity) VALUES (?, ?, ?)`,
        [presetInfo.lastInsertRowid, pieceTypeId, qty]);
    }
  }

  const product = await db.get(`SELECT * FROM products WHERE id = ?`, [productId]);
  const deliveryFeeNum = parseFloat(form.delivery_fee || '0');
  const assemblyFeeNum = parseFloat(form.assembly_fee || '0');
  const basePriceNum = parseFloat(form.base_price || '0');
  const whoLabel = who => who === 'Both' ? 'split between Dawson and Grant' : `to ${esc(who || 'unspecified')}`;

  // Stock just changed — push fresh numbers to the public showroom now
  // (fire-and-forget; the page never waits on GitHub, and any failure shows
  // on the Dashboard's sync card).
  syncShowroomInventory().catch(() => {});

  const ordersNote = orderRows.length
    ? `<div class="notice" style="background:#fdf3e0;border-color:#f0dcb0;color:#7a5a17;"><strong>📋 On order:</strong> ${orderRows.map(o => `${o.qty}× ${esc(o.label)} (${o.fulfillment === 'order' ? `ordering at ${money(ORDER_PIECE_COST_SHIPPED)}/box` : 'next trip'})`).join(', ')} — tracked on the <a href="/deposits">Deposits &amp; Orders</a> tab.</div>`
    : '';

  if (isDepositHold) {
    const totalPrice = basePriceNum + deliveryFeeNum + assemblyFeeNum;
    const body = `
      <div class="notice" style="background:#fdf3e0;border-color:#f0dcb0;color:#7a5a17;">
        <strong>🔒 Deposit logged (sale #${saleId}) — pieces held.</strong> ${product.sku}${form.customer_name ? ` for ${esc(form.customer_name)}` : ''} — ${money(depositAmount)} down, ${money(totalPrice - depositAmount)} due on delivery (${money(totalPrice)} total).
        Inventory and the website now show these pieces as gone. When it's paid and delivered, finish it from the <a href="/deposits"><strong>Deposits</strong></a> tab — that's when it counts as money made.
      </div>
      ${ordersNote}
      ${inventoryChangeCard(changes, location)}
      <a href="/deposits" class="btn" style="display:inline-block;text-decoration:none;margin-right:.5rem;">View deposits</a>
      <a href="/" class="btn" style="display:inline-block;text-decoration:none;background:var(--line);color:var(--ink);">Log another sale</a>
    `;
    return sendHtml(res, 200, layout({ title: 'Deposit logged', user, active: '/', body }));
  }

  const earnings = partnerEarnings({
    base_price: basePriceNum, delivery_fee: deliveryFeeNum, delivery_by: form.delivery_by,
    assembly_fee: assemblyFeeNum, assembly_by: form.assembly_by,
  });
  const costRate = await avgCostPerBox();
  const saleCostBasis = costRate * piecesTotal;
  const saleProfitEstimate = basePriceNum - saleCostBasis;
  const allTimeProfit = (await profitSummary()).totalProfit;
  const profitDelta = allTimeProfit - priorProfit;

  const body = `
    <div class="notice" style="background:#e3f5ec;border-color:#b9e3cc;color:#0f5c3d;">
      <strong>💰 Sale #${saleId} logged.</strong> ${product.sku} — ${money(basePriceNum)} base${deliveryFeeNum > 0 ? `, plus ${money(deliveryFeeNum)} delivery ${whoLabel(form.delivery_by)}` : ''}${assemblyFeeNum > 0 ? `, plus ${money(assemblyFeeNum)} assembly ${whoLabel(form.assembly_by)}` : ''}. Inventory updated automatically.
      ${form.save_preset_name && form.save_preset_name.trim() ? `<br>Saved as a new preset: "${esc(form.save_preset_name.trim())}" — it'll show up as a button next time.` : ''}
    </div>
    ${ordersNote}
    <div class="stat-grid">
      <div class="stat-card good"><div class="label">💵 Dawson made</div><div class="value">${money(earnings.Dawson)}</div></div>
      <div class="stat-card good"><div class="label">💵 Grant made</div><div class="value">${money(earnings.Grant)}</div></div>
      <div class="stat-card good"><div class="label">🛋️ Profit on this couch</div><div class="value">${money(saleProfitEstimate)}</div><div class="small muted">${money(basePriceNum)} sale − est. cost ${money(saleCostBasis)} (${piecesTotal} pc × ${money(costRate)}/box)</div></div>
      <div class="stat-card good"><div class="label">📈 All-time profit now</div><div class="value">${money(allTimeProfit)}</div><div class="small muted">⬆ up ${money(profitDelta)} from this sale</div></div>
    </div>
    ${inventoryChangeCard(changes, location)}
    ${await latestTripCard()}
    <a href="/" class="btn" style="display:inline-block;text-decoration:none;">Log another sale</a>
  `;
  sendHtml(res, 200, layout({ title: 'Sale logged', user, active: '/', body }));
}

// =============================================================================
// INVENTORY — raw, searchable piece counts. No "sellable couches" framing.
// =============================================================================
async function handleInventory(req, res, user) {
  const products = await activeProductSummaries({ includeInactive: true });
  const productBlocks = await Promise.all(products.map(async p => {
    const pieces = await piecesForProduct(p.id);
    return { product: p, pieces };
  }));

  const searchIndex = productBlocks.map(({ product }) => ({
    id: product.id, sku: product.sku.toLowerCase(), color: product.colorName.toLowerCase(), code: product.color.toLowerCase(),
  }));

  const body = `
  <h1 class="mt0">Inventory</h1>
  <input type="text" class="search-box" id="inv-search" placeholder="Search — e.g. &quot;120BE&quot; or &quot;Beige&quot;">

  ${productBlocks.map(({ product, pieces }) => `
    <div class="card inv-card" id="inv-card-${product.id}" style="background:${colorTint(product.color)};border-color:${colorSwatch(product.color)}4d;" data-sku="${esc(product.sku.toLowerCase())}" data-color="${esc(product.colorSearchTerms)}" data-code="${esc(product.color.toLowerCase())}">
      <div class="section-actions">
        <strong><span class="swatch-dot" style="background:${colorSwatch(product.color)}"></span>${esc(product.sku)} — ${esc(product.colorName)}</strong>
        <span>
          ${!product.active ? '<span class="pill muted">Discontinued</span>' : ''}
          ${product.rules_confidence === 'UNCONFIRMED' ? '<span class="pill warn">rules unconfirmed</span>' : ''}
          <a href="/inventory/adjust/${product.id}" class="small">Correct counts &rarr;</a>
        </span>
      </div>
      <table>
        <thead><tr><th>Piece</th><th>Dawson</th><th>Grant</th><th>Total</th></tr></thead>
        <tbody>
          ${pieces.map(pt => `
            <tr>
              <td data-label="Piece">${esc(pt.label)} <span class="small muted">${esc(pt.full_sku)}</span></td>
              <td data-label="Dawson">${pt.byLocation.Dawson}</td>
              <td data-label="Grant">${pt.byLocation.Grant}</td>
              <td data-label="Total"><span class="pill ${pt.total === 0 ? 'bad' : pt.total <= 1 ? 'warn' : 'good'}">${pt.total}</span></td>
            </tr>`).join('')}
        </tbody>
      </table>
    </div>
  `).join('')}
  <p class="small muted" id="no-results" style="display:none;">No products match that search.</p>

  <script>
    const idx = ${JSON.stringify(searchIndex)};
    const search = document.getElementById('inv-search');
    const noResults = document.getElementById('no-results');
    search.addEventListener('input', () => {
      const q = search.value.trim().toLowerCase();
      let shown = 0;
      for (const row of idx) {
        const el = document.getElementById('inv-card-' + row.id);
        const match = !q || row.sku.includes(q) || row.color.includes(q) || row.code.includes(q);
        el.style.display = match ? '' : 'none';
        if (match) shown++;
      }
      noResults.style.display = shown === 0 ? 'block' : 'none';
    });
  </script>
  `;
  sendHtml(res, 200, layout({ title: 'Inventory', user, active: '/inventory', body }));
}

// =============================================================================
// ADJUST INVENTORY — a direct "set the count" correction, separate from the
// additive Add Inventory flow above (which logs a real purchase with a cost
// and date). This is for fixing a miscount, not logging new boxes coming in.
// =============================================================================
async function handleAdjustInventoryGet(req, res, user, productId) {
  const product = await db.get(`SELECT * FROM products WHERE id = ?`, [productId]);
  if (!product) return sendHtml(res, 404, layout({ title: 'Not found', user, active: '/inventory', body: '<p>Product not found.</p>' }));
  const pieces = await piecesForProduct(productId);

  const rows = pieces.map(pt => `
    <div class="stepper-row">
      <div class="info">
        <div class="piece-label">${esc(pt.label)}</div>
        <div class="piece-stock">${esc(pt.full_sku)}</div>
      </div>
      <div style="display:flex;gap:1rem;flex-wrap:wrap;">
        <div>
          <div class="small muted" style="text-align:center;margin-bottom:.2rem;">Dawson</div>
          <div class="stepper">
            <button type="button" class="minus" onclick="step('${pt.id}_Dawson', -1)">−</button>
            <span class="qty" id="qty_${pt.id}_Dawson">${pt.byLocation.Dawson}</span>
            <button type="button" class="plus" onclick="step('${pt.id}_Dawson', 1)">+</button>
            <input type="hidden" name="dawson_${pt.id}" id="input_${pt.id}_Dawson" value="${pt.byLocation.Dawson}">
          </div>
        </div>
        <div>
          <div class="small muted" style="text-align:center;margin-bottom:.2rem;">Grant</div>
          <div class="stepper">
            <button type="button" class="minus" onclick="step('${pt.id}_Grant', -1)">−</button>
            <span class="qty" id="qty_${pt.id}_Grant">${pt.byLocation.Grant}</span>
            <button type="button" class="plus" onclick="step('${pt.id}_Grant', 1)">+</button>
            <input type="hidden" name="grant_${pt.id}" id="input_${pt.id}_Grant" value="${pt.byLocation.Grant}">
          </div>
        </div>
      </div>
    </div>
  `).join('');

  const body = `
  <a class="back-link" href="/inventory">&larr; Back to inventory</a>
  <h1 class="mt0">Correct counts — ${esc(product.sku)} — ${esc(colorName(product.color))}</h1>
  <p class="muted">This directly sets the count — it doesn't log a cost or a purchase. For real boxes coming in, use <a href="/inventory/add/${productId}">Add inventory</a> instead.</p>
  <form method="post" action="/inventory/adjust/${productId}">
    ${rows}
    <button type="submit" class="big-submit">Save counts</button>
  </form>
  <script>
    function step(key, delta) {
      const input = document.getElementById('input_' + key);
      const span = document.getElementById('qty_' + key);
      const next = Math.max(0, parseInt(input.value, 10) + delta);
      input.value = next;
      span.textContent = next;
    }
  </script>
  `;
  sendHtml(res, 200, layout({ title: `Correct ${product.sku}`, user, active: '/inventory', body }));
}

async function handleAdjustInventoryPost(req, res, user, productId) {
  const form = await readForm(req);
  const pieces = await piecesForProduct(productId);
  for (const pt of pieces) {
    const dawsonQty = Math.max(0, parseInt(form[`dawson_${pt.id}`] || '0', 10) || 0);
    const grantQty = Math.max(0, parseInt(form[`grant_${pt.id}`] || '0', 10) || 0);
    await db.run(`
      INSERT INTO inventory (piece_type_id, location, quantity) VALUES (?, 'Dawson', ?)
      ON CONFLICT(piece_type_id, location) DO UPDATE SET quantity = excluded.quantity
    `, [pt.id, dawsonQty]);
    await db.run(`
      INSERT INTO inventory (piece_type_id, location, quantity) VALUES (?, 'Grant', ?)
      ON CONFLICT(piece_type_id, location) DO UPDATE SET quantity = excluded.quantity
    `, [pt.id, grantQty]);
  }
  const product = await db.get(`SELECT * FROM products WHERE id = ?`, [productId]);
  const body = `
    <div class="notice" style="background:#e3f5ec;border-color:#b9e3cc;color:#0f5c3d;"><strong>Counts updated.</strong> ${esc(product.sku)} inventory corrected.</div>
    <a href="/inventory" class="btn" style="display:inline-block;text-decoration:none;margin-right:.5rem;">Back to inventory</a>
    <a href="/inventory/adjust/${productId}" class="btn" style="display:inline-block;text-decoration:none;background:var(--line);color:var(--ink);">Adjust again</a>
  `;
  // Stock just changed — push fresh numbers to the public showroom now
  // (fire-and-forget; the page never waits on GitHub, and any failure shows
  // on the Dashboard's sync card).
  syncShowroomInventory().catch(() => {});
  sendHtml(res, 200, layout({ title: 'Counts updated', user, active: '/inventory', body }));
}

// =============================================================================
// DASHBOARD — money + trip stats first; the piece-count estimate is a
// secondary, clearly-labeled estimate rather than the headline number.
// =============================================================================
async function handleDashboard(req, res, user, query) {
  // Opportunistic sync: visiting the dashboard is exactly when the app wakes
  // up from Render's free-tier sleep, so use that moment to catch up if it's
  // been over an hour since the last attempt — don't block the page on it.
  const { lastSyncAt } = getLastSyncStatus();
  if (Date.now() - lastSyncAt > 60 * 60 * 1000) {
    syncShowroomInventory().catch(() => {});
  }
  const syncNotice = query?.get('synced');

  const monthAgo = new Date(Date.now() - 30 * 24 * 3600 * 1000).toISOString().slice(0, 10);
  const grossThisMonth = (await db.get(`SELECT COALESCE(SUM(base_price + delivery_fee + assembly_fee), 0) s FROM sales WHERE date >= ?`, [monthAgo])).s;
  const salesThisMonth = (await db.get(`SELECT COUNT(*) c FROM sales WHERE date >= ?`, [monthAgo])).c;
  const owing = (await db.get(`SELECT COALESCE(SUM(base_price + delivery_fee + assembly_fee - COALESCE(deposit_amount, 0)), 0) s FROM sales WHERE payment_status IN ('Owing', 'Deposit')`)).s;

  const results = (await allProductsAvailability()).filter(r => r.product.active);
  const outOfStock = results.filter(r => r.availability.totalBoxesOnHand === 0);

  const { avg: avgSale } = await avgSalePrice();
  const expected = await expectedInventoryValue();
  const sellers = await bestSellers(5);
  const { firstDate, months } = await timeInBusiness();
  const profit = await profitSummary();
  const byModel = await salesByModel();
  const byColor = await salesByColor();
  const last5 = await recentSales(5);
  const trips = (await perTripStats()).slice().reverse(); // newest first
  const totalCost = profit.totalTripCost + profit.totalGasCost + profit.totalReceiptCost;
  const summaries = await activeProductSummaries();
  const costRate = await avgCostPerBox();
  const entered = await enteredByBreakdown();
  const openDeposits = (await db.get(`SELECT COUNT(*) c, COALESCE(SUM(base_price + delivery_fee + assembly_fee - COALESCE(deposit_amount,0)),0) bal FROM sales WHERE COALESCE(is_deposit_hold,0) = 1`));
  const openOrders = (await db.get(`SELECT COALESCE(SUM(quantity),0) q, COUNT(*) c FROM piece_orders WHERE status = 'open'`));

  const body = `
  <h1 class="mt0">Dashboard</h1>
  ${openDeposits.c > 0 ? `<div class="notice" style="background:#fdf3e0;border-color:#f0dcb0;color:#7a5a17;"><strong>🔒 ${openDeposits.c} deposit${openDeposits.c === 1 ? '' : 's'} waiting on delivery</strong> — ${money(openDeposits.bal)} still to collect. <a href="/deposits">Open the Deposits tab &rarr;</a></div>` : ''}
  ${openOrders.q > 0 ? `<div class="notice" style="background:#fdf3e0;border-color:#f0dcb0;color:#7a5a17;"><strong>📋 ${openOrders.q} piece${openOrders.q === 1 ? '' : 's'} on order</strong> for sold couches. <a href="/deposits">Open Deposits &amp; Orders &rarr;</a></div>` : ''}
  <div class="stat-grid">
    <div class="stat-card"><div class="label">💵 Gross sales, last 30 days</div><div class="value">${money(grossThisMonth)}</div></div>
    <div class="stat-card"><div class="label">Sales, last 30 days</div><div class="value">${salesThisMonth}</div></div>
    <div class="stat-card good"><div class="label">💵 Gross sales, all-time</div><div class="value">${money(profit.totalRevenue)}</div></div>
    <div class="stat-card ${profit.totalProfit >= 0 ? 'good' : 'bad'}"><div class="label">📈 All-time net profit</div><div class="value">${money(profit.totalProfit)}</div></div>
    <div class="stat-card ${profit.avgMonthlyProfit >= 0 ? 'good' : 'bad'}"><div class="label">📈 Avg monthly net profit</div><div class="value">${money(profit.avgMonthlyProfit)}</div></div>
    <div class="stat-card bad"><div class="label">💸 Total cost, all-time</div><div class="value">${money(totalCost)}</div></div>
    <div class="stat-card ${owing > 0 ? 'warn' : ''}"><div class="label">Still owed by customers</div><div class="value">${money(owing)}</div><div class="small muted">includes open deposits</div></div>
    <div class="stat-card ${outOfStock.length ? 'bad' : ''}"><div class="label">Completely out-of-stock lines</div><div class="value">${outOfStock.length}</div></div>
    <div class="stat-card"><div class="label">Avg sale price</div><div class="value">${money(avgSale)}</div></div>
    <div class="stat-card"><div class="label">Avg cost / box (buying)</div><div class="value">${money(costRate)}</div></div>
    <div class="stat-card good"><div class="label">💰 Expected $ of inventory on hand</div><div class="value">${money(expected.value)}</div><div class="small muted">${expected.totalBoxes} boxes × ${money(expected.rate)} avg sold/box</div></div>
    <div class="stat-card"><div class="label">Started</div><div class="value">${months} mo${months === 1 ? '' : 's'} ago</div><div class="small muted">${esc(firstDate || '—')}</div></div>
  </div>

  <div class="card">
    <strong>📈 Net profit split, avg / month</strong>
    <div class="stat-grid" style="margin-top:.6rem;margin-bottom:0;">
      <div class="stat-card good"><div class="label">Dawson</div><div class="value">${money(profit.avgMonthlyProfitSplit.Dawson)}</div></div>
      <div class="stat-card good"><div class="label">Grant</div><div class="value">${money(profit.avgMonthlyProfitSplit.Grant)}</div></div>
    </div>
  </div>

  <div class="card">
    <strong>📦 Inventory at a glance</strong>
    <p class="small muted" style="margin-top:.3rem;">Tap a box count for the Dawson/Grant split. Tap a tile to correct counts or add new stock.</p>
    <div class="product-grid" style="margin-top:.6rem;">
      ${summaries.map(p => `
        <a class="product-tile ${p.total === 0 ? 'out-of-stock' : ''}" href="/inventory/adjust/${p.id}" style="background:${colorTint(p.color, 0.16)};border-color:${colorSwatch(p.color)}55;">
          <div class="swatch" style="background:${colorSwatch(p.color)}"></div>
          <div class="sku">${esc(p.sku)}</div>
          <div class="colorname">${esc(p.colorName)}</div>
          <div class="stock ${p.total === 0 ? 'out' : p.total <= 2 ? 'low' : ''}" onclick="toggleStock(event, 'dash_${p.id}')">${p.total} box${p.total === 1 ? '' : 'es'} ▾</div>
          <div class="stock-breakdown" id="breakdown_dash_${p.id}">
            ${stockBreakdownRows(p.pieces)}
          </div>
        </a>
      `).join('')}
    </div>
  </div>

  <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(280px,1fr));gap:1rem;">
    <div class="card">
      <strong>🛋️ Last 5 sold</strong>
      <table style="margin-top:.6rem;">
        <thead><tr><th>Date</th><th>Product</th><th>Price</th></tr></thead>
        <tbody>
          ${last5.length ? last5.map(s => `<tr><td data-label="Date">${esc(s.date)}</td><td data-label="Product">${s.sku ? esc(s.sku) + ' — ' + esc(colorName(s.color)) : '—'}</td><td data-label="Price">${money((s.base_price || 0) + (s.delivery_fee || 0) + (s.assembly_fee || 0))}</td></tr>`).join('') : `<tr><td colspan="3" class="muted">No sales logged yet.</td></tr>`}
        </tbody>
      </table>
    </div>
    <div class="card">
      <strong>Best sellers</strong>
      <table style="margin-top:.6rem;">
        <thead><tr><th>Product</th><th>Sold</th><th>Revenue</th></tr></thead>
        <tbody>
          ${sellers.map(s => `<tr><td data-label="Product">${esc(s.sku)} — ${esc(colorName(s.color))}</td><td data-label="Sold">${s.saleCount}</td><td data-label="Revenue">${money(s.revenue)}</td></tr>`).join('')}
        </tbody>
      </table>
    </div>
  </div>

  <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(280px,1fr));gap:1rem;">
    <div class="card"><strong>Sales by model</strong><div style="margin-top:.6rem;">${barChart(byModel.map(m => ({ label: m.model, value: m.saleCount })), { width: 380, height: 190 })}</div></div>
    <div class="card"><strong>Sales by color</strong><div style="margin-top:.6rem;">${pieChart(byColor.map(c => ({ label: colorName(c.color), value: c.saleCount })), { size: 170 })}</div></div>
  </div>

  <div class="card">
    <strong>🚚 Trips</strong>
    <table style="margin-top:.6rem;">
      <thead><tr><th>Trip</th><th>Date</th><th>Cost</th><th>Boxes</th><th>Sets sold</th><th>Gross profit</th><th></th></tr></thead>
      <tbody>
        ${trips.map(t => `
          <tr>
            <td data-label="Trip"><strong>${t.trip_number != null ? 'Trip ' + t.trip_number : '—'}</strong></td>
            <td data-label="Date">${esc(t.date)}</td>
            <td data-label="Cost" class="bad-text">${money(t.total_cost)}</td>
            <td data-label="Boxes">${t.boxes_actual}</td>
            <td data-label="Sets sold">${t.setsSold}</td>
            <td data-label="Gross profit" class="${t.netProfit >= 0 ? 'good-text' : 'bad-text'}">${money(t.netProfit)}</td>
            <td data-label=""><a href="/trips/${t.id}/edit">Edit</a></td>
          </tr>
        `).join('')}
      </tbody>
    </table>
    <p class="small muted" style="margin-top:.6rem;"><a href="/trips">Log a new trip &rarr;</a></p>
  </div>

  <div class="card">
    <strong>Who's logged what</strong>
    <table style="margin-top:.6rem;">
      <thead><tr><th></th><th>Dawson</th><th>Grant</th></tr></thead>
      <tbody>
        <tr><td data-label="">Sales</td><td data-label="Dawson">${entered.sales.Dawson || 0}</td><td data-label="Grant">${entered.sales.Grant || 0}</td></tr>
        <tr><td data-label="">Trips</td><td data-label="Dawson">${entered.trips.Dawson || 0}</td><td data-label="Grant">${entered.trips.Grant || 0}</td></tr>
        <tr><td data-label="">Inventory added</td><td data-label="Dawson">${entered.receipts.Dawson || 0}</td><td data-label="Grant">${entered.receipts.Grant || 0}</td></tr>
      </tbody>
    </table>
    <p class="small muted" style="margin-bottom:0;">Net profit split: base price 50/50, delivery/assembly to whoever did them; shared trip + purchase costs split evenly.</p>
  </div>

  <p class="small muted">Looking for exact piece counts by color? The <a href="/inventory">Inventory</a> page is the source of truth.</p>
  ${outOfStock.length ? `<div class="notice bad">Completely out of stock: ${outOfStock.map(r => esc(r.product.sku)).join(', ')}.</div>` : ''}

  <div class="card">
    <strong>💾 Backup</strong>
    <p class="small muted" style="margin-top:.6rem;">Downloads the entire database — every sale, trip, and inventory count — as one file. Do this weekly and keep the file somewhere safe (email it to yourself or drop it in Google Drive). If anything ever happens to the database, this file is how we get everything back.</p>
    <a class="btn" href="/backup" style="display:inline-block;text-decoration:none;background:var(--line);color:var(--ink);">Download backup</a>
  </div>

  <div class="card">
    <strong>🔄 Showroom sync</strong>
    ${syncNotice === '1' ? `<div class="notice" style="background:#e3f5ec;border-color:#b9e3cc;color:#0f5c3d;margin-top:.6rem;">${esc(lastSyncStatusText(getLastSyncStatus()))}</div>` : ''}
    ${syncNotice === '0' ? `<div class="notice bad" style="margin-top:.6rem;">${esc(lastSyncStatusText(getLastSyncStatus()))}</div>` : ''}
    <p class="small muted" style="margin-top:.6rem;">Keeps the public showroom's stock numbers current automatically (checked hourly, and whenever this dashboard wakes the app back up). Only touches the small stock file, never your photos.</p>
    <p class="small muted">${lastSyncSummaryLine(getLastSyncStatus())}</p>
    <form method="post" action="/sync-showroom" style="margin:0;">
      <button type="submit" class="btn" style="background:var(--line);color:var(--ink);">Sync showroom now</button>
    </form>
  </div>

  <script>
    function toggleStock(ev, id) {
      ev.preventDefault();
      ev.stopPropagation();
      const el = document.getElementById('breakdown_' + id);
      if (el) el.classList.toggle('open');
    }
  </script>
  `;
  sendHtml(res, 200, layout({ title: 'Dashboard', user, active: '/dashboard', body }));
}

function lastSyncSummaryLine({ lastSyncAt, lastSyncResult }) {
  if (!lastSyncAt) return 'Hasn’t run yet since this server started.';
  const when = new Date(lastSyncAt).toLocaleString();
  if (!lastSyncResult) return `Last attempt: ${when}.`;
  return lastSyncResult.ok
    ? `Last synced: ${when} — ${lastSyncResult.detail}`
    : `Last attempt (${when}) didn't go through: ${lastSyncResult.detail}`;
}

function lastSyncStatusText({ lastSyncResult }) {
  if (!lastSyncResult) return 'No sync result yet.';
  return lastSyncResult.ok ? `Synced. ${lastSyncResult.detail}` : `Sync failed: ${lastSyncResult.detail}`;
}

async function handleSyncShowroom(req, res, user) {
  const result = await syncShowroomInventory();
  redirect(res, `/dashboard?synced=${result.ok ? '1' : '0'}`);
}

// =============================================================================
// TRIPS
// =============================================================================
async function handleTripsGet(req, res, user, notice) {
  const trips = await db.all(`SELECT * FROM trips ORDER BY date DESC, id DESC`);
  const photosByTrip = {};
  for (const row of await db.all(`SELECT * FROM trip_photos ORDER BY id`)) {
    (photosByTrip[row.trip_id] ||= []).push(row);
  }
  // Sale counter + per-trip sold counts: new sales auto-link to the newest
  // trip, so these keep themselves current as sales get logged.
  const saleCounter = await db.get(`SELECT COUNT(*) c, MAX(id) maxId FROM sales`);
  const soldByTrip = Object.fromEntries(
    (await db.all(`SELECT trip_id, COUNT(*) c FROM sales WHERE trip_id IS NOT NULL AND COALESCE(is_deposit_hold,0) = 0 GROUP BY trip_id`)).map(r => [r.trip_id, r.c]));
  const body = `
  <h1 class="mt0">Trips</h1>
  ${notice ? `<div class="notice ${notice.bad ? 'bad' : ''}">${esc(notice.text)}</div>` : ''}
  <div class="stat-grid">
    <div class="stat-card"><div class="label">🧾 Sales logged, all-time</div><div class="value">${saleCounter.c}</div><div class="small muted">latest is sale #${saleCounter.maxId ?? '—'} — next one will be #${(saleCounter.maxId ?? 0) + 1}</div></div>
  </div>
  <div class="card">
    <h2 class="mt0">Log a new trip</h2>
    <form method="post" action="/trips" id="trip-form">
      <div class="field-block"><label class="field-label">Date</label><input type="date" name="date" value="${today()}" required></div>
      <div class="field-block"><label class="field-label">Traveler</label>${buttonGroup('traveler', ['Dawson', 'Grant', 'Both'])}</div>
      <div class="field-block"><label class="field-label">Boxes expected (if you planned a number before leaving — leave blank if it's random)</label><input type="number" name="boxes_expected" min="0" inputmode="numeric"></div>
      <div class="field-block"><label class="field-label">Boxes actual (what you counted once home)</label><input type="number" name="boxes_actual" min="0" required inputmode="numeric"></div>
      <div class="field-block"><label class="field-label">Total cost ($, wholesale)</label><input type="number" name="total_cost" min="0" step="1" required inputmode="numeric"></div>
      <div class="field-block"><label class="field-label">Gas / travel cost ($)</label><input type="number" name="gas_cost" min="0" step="1" value="0" inputmode="numeric"></div>
      <div class="field-block"><label class="field-label">Notes</label><input type="text" name="notes"></div>
      <div class="field-block">
        <label class="field-label">Photos (optional)</label>
        <input type="file" accept="image/*" multiple id="trip-photo-input">
        <div id="trip-photo-previews" style="display:flex;gap:.5rem;flex-wrap:wrap;margin-top:.6rem;"></div>
        <input type="hidden" name="photos_json" id="photos_json_input">
        <p class="small muted" id="photo-status"></p>
      </div>
      <button type="submit" class="big-submit">Log trip</button>
    </form>
  </div>
  <script>
    (function() {
      const input = document.getElementById('trip-photo-input');
      const previews = document.getElementById('trip-photo-previews');
      const hidden = document.getElementById('photos_json_input');
      const status = document.getElementById('photo-status');
      let photos = [];
      input.addEventListener('change', async () => {
        status.textContent = 'Processing photos…';
        photos = [];
        previews.innerHTML = '';
        for (const file of Array.from(input.files)) {
          const dataUrl = await compress(file);
          photos.push(dataUrl);
          const img = document.createElement('img');
          img.src = dataUrl;
          img.style.cssText = 'width:64px;height:64px;object-fit:cover;border-radius:8px;border:1px solid #e5e2dc;';
          previews.appendChild(img);
        }
        hidden.value = JSON.stringify(photos);
        status.textContent = photos.length ? (photos.length + ' photo(s) attached') : '';
      });
      function compress(file) {
        return new Promise((resolve) => {
          const img = new Image();
          const reader = new FileReader();
          reader.onload = () => { img.onload = () => {
            const maxW = 900;
            const scale = Math.min(1, maxW / img.width);
            const canvas = document.createElement('canvas');
            canvas.width = img.width * scale;
            canvas.height = img.height * scale;
            const ctx = canvas.getContext('2d');
            ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
            resolve(canvas.toDataURL('image/jpeg', 0.6));
          }; img.src = reader.result; };
          reader.readAsDataURL(file);
        });
      }
    })();
  </script>
  <h2>History</h2>
  <table>
    <thead><tr><th>Trip</th><th>Date</th><th>Traveler</th><th>Expected</th><th>Actual</th><th>Cost</th><th>Gas</th><th>Sold</th><th>Logged by</th><th>Photos</th><th></th></tr></thead>
    <tbody>
      ${trips.map(t => {
        const mismatch = t.boxes_expected != null && t.boxes_expected !== t.boxes_actual;
        const photos = photosByTrip[t.id] || [];
        return `<tr>
          <td data-label="Trip"><strong>${t.trip_number != null ? 'Trip ' + t.trip_number : '—'}</strong></td>
          <td data-label="Date">${esc(t.date)}</td>
          <td data-label="Traveler">${esc(t.traveler || '—')}</td>
          <td data-label="Expected">${t.boxes_expected ?? '—'}</td>
          <td data-label="Actual">${t.boxes_actual} ${mismatch ? `<span class="pill bad">mismatch</span>` : ''}</td>
          <td data-label="Cost">${money(t.total_cost)}</td>
          <td data-label="Gas">${t.gas_cost ? money(t.gas_cost) : '—'}</td>
          <td data-label="Sold">${soldByTrip[t.id] || 0}</td>
          <td data-label="Logged by">${esc(t.entered_by || '—')}</td>
          <td data-label="Photos">${photos.map(p => `<a href="/uploads/trip-photos/${esc(p.file_path)}" target="_blank"><img src="/uploads/trip-photos/${esc(p.file_path)}" style="width:40px;height:40px;object-fit:cover;border-radius:6px;margin-right:.2rem;"></a>`).join('') || '—'}</td>
          <td data-label=""><a href="/trips/${t.id}/edit">Edit</a></td>
        </tr>`;
      }).join('')}
    </tbody>
  </table>
  `;
  sendHtml(res, 200, layout({ title: 'Trips', user, active: '/trips', body }));
}

// --- edit an existing trip ---
async function handleTripEditGet(req, res, user, tripId) {
  const trip = await db.get(`SELECT * FROM trips WHERE id = ?`, [tripId]);
  if (!trip) return sendHtml(res, 404, layout({ title: 'Not found', user, active: '/trips', body: '<p>Trip not found.</p>' }));

  const body = `
  <a class="back-link" href="/trips">&larr; Back to trips</a>
  <h1 class="mt0">Edit ${trip.trip_number != null ? 'Trip ' + trip.trip_number : 'trip'}</h1>
  <form method="post" action="/trips/${tripId}/edit">
    <div class="field-block"><label class="field-label">Date</label><input type="date" name="date" value="${esc(trip.date)}" required></div>
    <div class="field-block"><label class="field-label">Traveler</label>${buttonGroup('traveler', ['Dawson', 'Grant', 'Both'], { selected: trip.traveler })}</div>
    <div class="field-block"><label class="field-label">Boxes expected</label><input type="number" name="boxes_expected" min="0" inputmode="numeric" value="${trip.boxes_expected ?? ''}"></div>
    <div class="field-block"><label class="field-label">Boxes actual</label><input type="number" name="boxes_actual" min="0" required inputmode="numeric" value="${trip.boxes_actual}"></div>
    <div class="field-block"><label class="field-label">Total cost ($)</label><input type="number" name="total_cost" min="0" step="1" required inputmode="numeric" value="${trip.total_cost}"></div>
    <div class="field-block"><label class="field-label">Gas / travel cost ($)</label><input type="number" name="gas_cost" min="0" step="1" inputmode="numeric" value="${trip.gas_cost || 0}"></div>
    <div class="field-block"><label class="field-label">Notes</label><input type="text" name="notes" value="${esc(trip.notes || '')}"></div>
    <button type="submit" class="big-submit">Save changes</button>
  </form>
  `;
  sendHtml(res, 200, layout({ title: 'Edit trip', user, active: '/trips', body }));
}

async function handleTripEditPost(req, res, user, tripId) {
  const form = await readForm(req);
  const boxesExpected = form.boxes_expected && form.boxes_expected.trim() !== '' ? parseInt(form.boxes_expected, 10) : null;
  await db.run(`UPDATE trips SET date = ?, traveler = ?, boxes_expected = ?, boxes_actual = ?, total_cost = ?, gas_cost = ?, notes = ? WHERE id = ?`,
    [form.date, form.traveler, boxesExpected, parseInt(form.boxes_actual, 10), parseFloat(form.total_cost), parseFloat(form.gas_cost || '0'), form.notes || null, tripId]);
  await handleTripsGet(req, res, user, { text: 'Trip updated.' });
}

async function handleTripsPost(req, res, user) {
  const form = await readForm(req);
  const boxesExpected = form.boxes_expected && form.boxes_expected.trim() !== '' ? parseInt(form.boxes_expected, 10) : null;
  const boxesActual = parseInt(form.boxes_actual, 10);
  const nextNum = ((await db.get(`SELECT MAX(trip_number) m FROM trips`)).m || 0) + 1;

  const info = await db.run(`INSERT INTO trips (trip_number, date, traveler, boxes_expected, boxes_actual, total_cost, gas_cost, notes, entered_by, is_historical) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 0)`,
    [nextNum, form.date, form.traveler, boxesExpected, boxesActual, parseFloat(form.total_cost), parseFloat(form.gas_cost || '0'), form.notes || null, user.name]);
  const tripId = info.lastInsertRowid;

  let photoCount = 0;
  if (form.photos_json) {
    try {
      const photos = JSON.parse(form.photos_json);
      for (let i = 0; i < photos.length; i++) {
        const match = /^data:image\/(\w+);base64,(.+)$/.exec(photos[i]);
        if (!match) continue;
        const ext = match[1] === 'jpeg' ? 'jpg' : match[1];
        const filename = `trip-${tripId}-${i}-${Math.random().toString(36).slice(2, 8)}.${ext}`;
        fs.writeFileSync(path.join(UPLOADS_DIR, filename), Buffer.from(match[2], 'base64'));
        await db.run(`INSERT INTO trip_photos (trip_id, file_path, uploaded_by) VALUES (?, ?, ?)`, [tripId, filename, user.name]);
        photoCount++;
      }
    } catch { /* malformed photo payload — skip silently, trip itself still saved */ }
  }

  let notice = { text: `Trip logged.${photoCount ? ` ${photoCount} photo(s) attached.` : ''}` };
  if (boxesExpected != null && boxesExpected !== boxesActual) {
    notice = { bad: true, text: `Trip logged — but expected ${boxesExpected} boxes and actually counted ${boxesActual}. Worth a quick double-check before this becomes permanent.` };
  }
  await handleTripsGet(req, res, user, notice);
}

// =============================================================================
// ADD INVENTORY — no such flow existed before; boxes just showed up in the
// spreadsheet with no record of when/how. Same product-picker → steppers
// pattern as logging a sale, but adding instead of subtracting stock.
// =============================================================================
async function handleAddInventoryPicker(req, res, user) {
  const products = await activeProductSummaries();
  const body = `
  <h1 class="mt0">Add inventory — what came in?</h1>
  <input type="text" class="search-box" id="product-search" placeholder="Search — e.g. &quot;120BE&quot; or &quot;Beige&quot;" autofocus>
  <div class="product-grid" id="product-grid">
    ${products.map(p => `
      <a class="product-tile" href="/inventory/add/${p.id}" data-sku="${esc(p.sku.toLowerCase())}" data-color="${esc(p.colorSearchTerms)}" data-code="${esc(p.color.toLowerCase())}">
        <div class="swatch" style="background:${p.swatch}"></div>
        <div class="sku">${esc(p.sku)}</div>
        <div class="colorname">${esc(p.colorName)}</div>
        <div class="stock">${p.total} on hand now</div>
      </a>
    `).join('')}
  </div>
  <p class="small muted" id="no-results" style="display:none;">No products match that search.</p>
  <script>
    const search = document.getElementById('product-search');
    const tiles = Array.from(document.querySelectorAll('.product-tile'));
    const noResults = document.getElementById('no-results');
    search.addEventListener('input', () => {
      const q = search.value.trim().toLowerCase();
      let shown = 0;
      for (const tile of tiles) {
        const match = !q || tile.dataset.sku.includes(q) || tile.dataset.color.includes(q) || tile.dataset.code.includes(q);
        tile.style.display = match ? '' : 'none';
        if (match) shown++;
      }
      noResults.style.display = shown === 0 ? 'block' : 'none';
    });
  </script>
  `;
  sendHtml(res, 200, layout({ title: 'Add inventory', user, active: '/inventory/add', body, wide: true }));
}

async function handleAddInventoryProduct(req, res, user, productId) {
  const product = await db.get(`SELECT * FROM products WHERE id = ?`, [productId]);
  if (!product) return sendHtml(res, 404, layout({ title: 'Not found', user, active: '/inventory/add', body: '<p>Product not found.</p>' }));

  const pieces = await piecesForProduct(productId);
  const suggestedCost = suggestedUnitCost(product.sku);
  const recentTrips = await db.all(`SELECT id, date, trip_number FROM trips ORDER BY date DESC, id DESC LIMIT 20`);

  const stepperFields = pieces.map(pt => `
    <div class="stepper-row">
      <div class="info">
        <div class="piece-label">${esc(pt.label)}</div>
        <div class="piece-stock">${pt.full_sku} · currently D:${pt.byLocation.Dawson} / G:${pt.byLocation.Grant}</div>
      </div>
      <div class="stepper" data-piece="${pt.id}">
        <button type="button" class="minus" onclick="step(${pt.id}, -1)">−</button>
        <span class="qty" id="qty_${pt.id}">0</span>
        <button type="button" class="plus" onclick="step(${pt.id}, 1)">+</button>
        <input type="hidden" name="piece_${pt.id}" id="input_${pt.id}" value="0">
      </div>
    </div>
  `).join('');

  const body = `
  <a class="back-link" href="/inventory/add">&larr; Back to products</a>
  <h1 class="mt0">Add ${esc(product.sku)} — ${esc(colorName(product.color))}</h1>
  <p class="muted">Tap + for each piece that came in.</p>
  <form method="post" action="/inventory/add/${productId}">
    ${stepperFields}

    <h2>Whose stock is this going to?</h2>
    <div class="field-block">
      ${buttonGroup('location', [
        { value: user.name, label: `${user.name} (you)` },
        { value: user.name === 'Dawson' ? 'Grant' : 'Dawson', label: user.name === 'Dawson' ? 'Grant' : 'Dawson' },
        { value: 'Split', label: 'Split evenly' },
      ])}
    </div>

    <h2>Cost</h2>
    <div class="field-block">
      <label class="field-label">Date</label>
      <input type="date" name="date" value="${today()}" required>
    </div>
    <div class="field-block">
      <label class="field-label">Cost per box ($)</label>
      <input type="number" name="unit_cost" min="0" step="1" value="${suggestedCost}" inputmode="numeric" id="unit-cost-input">
      <p class="small muted">Starting suggestion for ${esc(product.sku)} — change it any time (one-off purchases, discounts, etc all vary).</p>
    </div>
    <div class="field-block">
      <label class="field-label"><input type="checkbox" id="online-order-check" onchange="document.getElementById('unit-cost-input').value = this.checked ? ${ONLINE_ORDER_COST_PER_BOX} : ${suggestedCost};" style="width:auto;margin-right:.5rem;"> Ordered online (${money(ONLINE_ORDER_COST_PER_BOX)}/box — pricier than the usual ${money(suggestedCost)})</label>
    </div>
    <div class="field-block">
      <label class="field-label"><input type="checkbox" name="is_free" value="1" onchange="document.getElementById('unit-cost-input').disabled = this.checked;" style="width:auto;margin-right:.5rem;"> These came free (bonus pieces)</label>
    </div>
    <div class="field-block">
      <label class="field-label">Link to a trip? (optional — leave as "None" for a random one-off purchase)</label>
      <select name="trip_id" style="width:100%;padding:.8rem .9rem;font-size:1.1rem;border:2px solid var(--line);border-radius:12px;">
        <option value="">None — not tied to a specific trip</option>
        ${recentTrips.map(t => `<option value="${t.id}">${esc(t.date)}${t.trip_number ? ' — trip #' + t.trip_number : ''}</option>`).join('')}
      </select>
    </div>
    <div class="field-block">
      <label class="field-label">Notes (optional)</label>
      <input type="text" name="notes">
    </div>

    <button type="submit" class="big-submit">Add to inventory</button>
  </form>
  <script>
    function step(id, delta) {
      const input = document.getElementById('input_' + id);
      const span = document.getElementById('qty_' + id);
      const next = Math.max(0, parseInt(input.value, 10) + delta);
      input.value = next;
      span.textContent = next;
    }
  </script>
  `;
  sendHtml(res, 200, layout({ title: `Add ${product.sku}`, user, active: '/inventory/add', body, wide: true }));
}

async function handleAddInventorySubmit(req, res, user, productId) {
  const form = await readForm(req);
  const pieces = await piecesForProduct(productId);
  const isFree = form.is_free === '1';
  const unitCost = isFree ? 0 : parseFloat(form.unit_cost || '0');
  const tripId = form.trip_id ? parseInt(form.trip_id, 10) : null;
  const location = form.location;

  let totalAdded = 0;
  for (const pt of pieces) {
    const qty = parseInt(form[`piece_${pt.id}`] || '0', 10) || 0;
    if (qty <= 0) continue;
    totalAdded += qty;

    const allocations = location === 'Split'
      ? [['Dawson', Math.ceil(qty / 2)], ['Grant', Math.floor(qty / 2)]].filter(([, q]) => q > 0)
      : [[location, qty]];

    for (const [loc, q] of allocations) {
      await db.run(`
        INSERT INTO inventory (piece_type_id, location, quantity) VALUES (?, ?, ?)
        ON CONFLICT(piece_type_id, location) DO UPDATE SET quantity = quantity + excluded.quantity
      `, [pt.id, loc, q]);
      await db.run(`
        INSERT INTO inventory_receipts (date, piece_type_id, location, quantity, unit_cost, is_free, trip_id, entered_by, notes, is_historical)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 0)
      `, [form.date, pt.id, loc, q, unitCost, isFree ? 1 : 0, tripId, user.name, form.notes || null]);
    }
  }

  const product = await db.get(`SELECT * FROM products WHERE id = ?`, [productId]);
  const body = totalAdded === 0
    ? `<div class="notice bad">No pieces were selected — nothing added.</div><p><a href="/inventory/add/${productId}">Try again</a></p>`
    : `
      <div class="notice" style="background:#e3f5ec;border-color:#b9e3cc;color:#0f5c3d;">
        <strong>Inventory updated.</strong> Added ${totalAdded} box${totalAdded === 1 ? '' : 'es'} of ${esc(product.sku)}${isFree ? ' (free)' : ` at ${money(unitCost)}/box`}.
      </div>
      <a href="/inventory/add/${productId}" class="btn" style="display:inline-block;text-decoration:none;margin-right:.5rem;">Add more of this</a>
      <a href="/inventory/add" class="btn" style="display:inline-block;text-decoration:none;background:var(--line);color:var(--ink);">Add a different product</a>
    `;
  // Stock just changed — push fresh numbers to the public showroom now
  // (fire-and-forget; the page never waits on GitHub, and any failure shows
  // on the Dashboard's sync card).
  syncShowroomInventory().catch(() => {});
  sendHtml(res, 200, layout({ title: 'Inventory updated', user, active: '/inventory/add', body }));
}

// =============================================================================
// SALES HISTORY — a searchable log, replacing the sales list that the
// redesigned "log a sale" home page pushed out. Also answers "what have I
// logged vs what has Grant logged" via the entered-by filter.
// =============================================================================
async function handleSalesHistory(req, res, user) {
  const sales = await db.all(`
    SELECT sales.*, products.sku, products.color FROM sales
    LEFT JOIN products ON products.id = sales.product_id
    ORDER BY sales.date DESC, sales.id DESC
    LIMIT 300
  `);

  const rows = sales.map(s => ({
    id: s.id, date: s.date, sku: s.sku || '—', colorName: s.color ? colorName(s.color) : '',
    pieces: s.pieces_total, total: (s.base_price || 0) + (s.delivery_fee || 0) + (s.assembly_fee || 0),
    status: s.is_deposit_hold ? 'Deposit hold' : s.payment_status, enteredBy: s.entered_by || (s.is_historical ? 'imported history' : '—'),
  }));

  const body = `
  <h1 class="mt0">Sales history</h1>
  <input type="text" class="search-box" id="sales-search" placeholder="Search — SKU, color, who logged it...">
  <table id="sales-table">
    <thead><tr><th>Date</th><th>Product</th><th>Pieces</th><th>Total</th><th>Status</th><th>Logged by</th><th></th></tr></thead>
    <tbody>
      ${rows.map(r => `
        <tr data-idx="${r.id}" data-terms="${esc((r.sku + ' ' + r.colorName + ' ' + r.enteredBy).toLowerCase())}">
          <td data-label="Date">${esc(r.date)}</td>
          <td data-label="Product">${esc(r.sku)} ${r.colorName ? '— ' + esc(r.colorName) : ''}</td>
          <td data-label="Pieces">${r.pieces ?? '—'}</td>
          <td data-label="Total">${money(r.total)}</td>
          <td data-label="Status"><span class="pill ${r.status === 'Owing' ? 'bad' : (r.status === 'Deposit' || r.status === 'Deposit hold') ? 'warn' : 'good'}">${esc(r.status)}</span></td>
          <td data-label="Logged by">${esc(r.enteredBy)}</td>
          <td data-label="">
            <a href="/sales/${r.id}/edit">Edit</a>
            <form method="post" action="/sales/${r.id}/delete" style="display:inline;" onsubmit="return confirm('Delete this sale? The pieces go back into inventory and this can\\'t be undone.');">
              <button type="submit" style="background:none;border:none;color:var(--bad);padding:0;margin-left:.7rem;text-decoration:underline;cursor:pointer;font-size:.92rem;">Delete</button>
            </form>
          </td>
        </tr>
      `).join('')}
    </tbody>
  </table>
  <p class="small muted">Showing the most recent 300 sales.</p>
  <script>
    const search = document.getElementById('sales-search');
    const rows = Array.from(document.querySelectorAll('#sales-table tbody tr'));
    search.addEventListener('input', () => {
      const q = search.value.trim().toLowerCase();
      for (const row of rows) row.style.display = (!q || row.dataset.terms.includes(q)) ? '' : 'none';
    });
  </script>
  `;
  sendHtml(res, 200, layout({ title: 'Sales history', user, active: '/sales', body, wide: true }));
}

// --- edit an existing sale (financial/status fields only — pieces & inventory aren't touched here) ---
async function handleSaleEditGet(req, res, user, saleId) {
  const sale = await db.get(`SELECT sales.*, products.sku FROM sales LEFT JOIN products ON products.id = sales.product_id WHERE sales.id = ?`, [saleId]);
  if (!sale) return sendHtml(res, 404, layout({ title: 'Not found', user, active: '/sales', body: '<p>Sale not found.</p>' }));

  const body = `
  <a class="back-link" href="/sales">&larr; Back to sales history</a>
  <h1 class="mt0">Edit sale — ${esc(sale.sku || 'unknown product')}</h1>
  <p class="muted small">Piece counts and product aren't editable here (that would need to touch inventory) — this covers price, payment, and delivery/assembly details.</p>
  <form method="post" action="/sales/${saleId}/edit">
    <div class="field-block"><label class="field-label">Date</label><input type="date" name="date" value="${esc(sale.date)}" required></div>
    <div class="field-block"><label class="field-label">Base price ($)</label><input type="number" name="base_price" min="0" step="1" required inputmode="numeric" value="${sale.base_price}"></div>
    <div class="field-block">
      <label class="field-label">Delivery fee ($)</label>
      <input type="number" name="delivery_fee" min="0" step="1" inputmode="numeric" value="${sale.delivery_fee || 0}">
      ${buttonGroup('delivery_by', [{ value: '', label: 'No delivery' }, 'Dawson', 'Grant', 'Both'], { selected: sale.delivery_by || '' })}
    </div>
    <div class="field-block">
      <label class="field-label">Assembly fee ($)</label>
      <input type="number" name="assembly_fee" min="0" step="1" inputmode="numeric" value="${sale.assembly_fee || 0}">
      ${buttonGroup('assembly_by', [{ value: '', label: 'No assembly' }, 'Dawson', 'Grant', 'Both'], { selected: sale.assembly_by || '' })}
    </div>
    <div class="field-block"><label class="field-label">Paid how?</label>${buttonGroup('payment_method', ['Cash', 'Venmo', 'Other'], { selected: sale.payment_method })}</div>
    <div class="field-block"><label class="field-label">Payment status</label>${buttonGroup('payment_status', ['Paid', 'Deposit', 'Owing'], { selected: sale.payment_status })}</div>
    <div class="field-block"><label class="field-label">Deposit amount ($)</label><input type="number" name="deposit_amount" min="0" step="1" inputmode="numeric" value="${sale.deposit_amount || 0}"></div>
    <div class="field-block"><label class="field-label">Notes</label><input type="text" name="notes" value="${esc(sale.notes || '')}"></div>
    <button type="submit" class="big-submit">Save changes</button>
  </form>
  <form method="post" action="/sales/${saleId}/delete" style="margin-top:1rem;" onsubmit="return confirm('Delete this sale? The pieces go back into inventory and this can\\'t be undone.');">
    <button type="submit" style="width:100%;padding:.9rem;font-size:1rem;font-weight:700;border-radius:12px;background:#fbe7e7;color:var(--bad);border:1px solid #f0bcbc;">Delete this sale</button>
  </form>
  `;
  sendHtml(res, 200, layout({ title: 'Edit sale', user, active: '/sales', body }));
}

async function handleSaleDelete(req, res, user, saleId) {
  // Put the pieces this sale used back into inventory before removing it —
  // deleting a sale should undo its inventory effect, not just its record.
  const items = await db.all(`SELECT * FROM sale_items WHERE sale_id = ?`, [saleId]);
  for (const item of items) {
    await db.run(`
      INSERT INTO inventory (piece_type_id, location, quantity) VALUES (?, ?, ?)
      ON CONFLICT(piece_type_id, location) DO UPDATE SET quantity = quantity + excluded.quantity
    `, [item.piece_type_id, item.location, item.quantity]);
  }
  // Delete sale_items explicitly rather than relying on ON DELETE CASCADE —
  // some remote SQLite-protocol backends don't honor session-level FK
  // pragmas the same way a local connection does, so this can't be assumed.
  await db.run(`DELETE FROM sale_items WHERE sale_id = ?`, [saleId]);
  // Any still-open backorders tied to this sale die with it (those pieces
  // never came out of inventory, so there's nothing to restore for them).
  await db.run(`DELETE FROM piece_orders WHERE sale_id = ? AND status = 'open'`, [saleId]);
  await db.run(`DELETE FROM sales WHERE id = ?`, [saleId]);
  // Stock just changed (pieces went back) — keep the public showroom honest.
  syncShowroomInventory().catch(() => {});
  redirect(res, '/sales');
}

// =============================================================================
// DEPOSITS — couches with money down (usually $100) but not yet paid in full /
// delivered. Pieces are already held (decremented + synced to the showroom);
// completing one here is what turns it into real, counted revenue.
// =============================================================================
async function handleDeposits(req, res, user, notice) {
  // Next delivery first; deposits without a delivery date sink to the bottom
  // (they need one set — the edit panel on each card does it).
  const holds = await db.all(`
    SELECT sales.*, products.sku, products.color FROM sales
    LEFT JOIN products ON products.id = sales.product_id
    WHERE COALESCE(sales.is_deposit_hold, 0) = 1
    ORDER BY (sales.delivery_date IS NULL) ASC, sales.delivery_date ASC, sales.date ASC, sales.id ASC
  `);
  const owed = holds.reduce((sum, s) => sum + ((s.base_price || 0) + (s.delivery_fee || 0) + (s.assembly_fee || 0) - (s.deposit_amount || 0)), 0);

  // Piece breakdowns: what's held from stock, and what's still needed
  // (oversold shortfalls) with how each one's being covered.
  const holdIds = holds.map(s => s.id);
  const itemsBySale = {}, ordersBySale = {};
  if (holdIds.length) {
    const ph = holdIds.map(() => '?').join(',');
    for (const r of await db.all(`
      SELECT sale_items.sale_id, sale_items.quantity, piece_types.label
      FROM sale_items JOIN piece_types ON piece_types.id = sale_items.piece_type_id
      WHERE sale_items.sale_id IN (${ph})`, holdIds)) (itemsBySale[r.sale_id] ||= []).push(r);
    for (const r of await db.all(`
      SELECT piece_orders.*, piece_types.label
      FROM piece_orders JOIN piece_types ON piece_types.id = piece_orders.piece_type_id
      WHERE piece_orders.sale_id IN (${ph})`, holdIds)) (ordersBySale[r.sale_id] ||= []).push(r);
  }

  // All open piece orders (deposit or not) — Orders lives on this page now.
  const openOrders = await db.all(`
    SELECT piece_orders.*, piece_types.label, piece_types.full_sku, products.sku, products.color,
           sales.customer_name, sales.date AS sale_date, COALESCE(sales.is_deposit_hold, 0) AS sale_is_hold
    FROM piece_orders
    JOIN piece_types ON piece_types.id = piece_orders.piece_type_id
    JOIN products ON products.id = piece_types.product_id
    LEFT JOIN sales ON sales.id = piece_orders.sale_id
    WHERE piece_orders.status = 'open'
    ORDER BY piece_orders.created_at ASC
  `);

  const body = `
  <h1 class="mt0">Deposits &amp; Orders</h1>
  ${notice ? `<div class="notice ${notice.bad ? 'bad' : ''}">${esc(notice.text)}</div>` : ''}
  <div class="stat-grid">
    <div class="stat-card ${owed > 0 ? 'warn' : ''}"><div class="label">💰 Owed to us from deposits</div><div class="value">${money(owed)}</div><div class="small muted">${holds.length} open deposit${holds.length === 1 ? '' : 's'}</div></div>
    <div class="stat-card ${openOrders.length ? 'warn' : ''}"><div class="label">📋 Pieces on order</div><div class="value">${openOrders.reduce((n, o) => n + o.quantity, 0)}</div><div class="small muted">${openOrders.length} open order line${openOrders.length === 1 ? '' : 's'}</div></div>
  </div>
  ${holds.length === 0 ? `<div class="card"><p class="muted" style="margin:0;">No open deposits. When you log a sale with "Deposit — pay on delivery", it shows up here.</p></div>` : ''}
  ${holds.map(s => {
    const total = (s.base_price || 0) + (s.delivery_fee || 0) + (s.assembly_fee || 0);
    const balance = total - (s.deposit_amount || 0);
    const days = Math.max(0, Math.round((Date.now() - new Date(s.date).getTime()) / 86400000));
    const held = itemsBySale[s.id] || [];
    const shorts = ordersBySale[s.id] || [];
    return `
    <div class="card" style="border-left:4px solid #e0a93e;">
      <div class="section-actions">
        <strong>Sale #${s.id} — ${esc(s.sku || '?')} ${s.color ? '— ' + esc(colorName(s.color)) : ''}${s.customer_name ? ` · ${esc(s.customer_name)}` : ''}</strong>
        <span>${s.delivery_date ? `<span class="pill good">🚚 delivering ${esc(s.delivery_date)}</span>` : `<span class="pill bad">no delivery date yet</span>`} <span class="pill warn">held ${days} day${days === 1 ? '' : 's'}</span></span>
      </div>
      <table style="margin-top:.5rem;">
        <tbody>
          <tr><td data-label="">Deposit taken</td><td data-label="Deposit">${money(s.deposit_amount || 0)} on ${esc(s.date)} by ${esc(s.entered_by || '—')}</td></tr>
          <tr><td data-label="">Agreed total</td><td data-label="Total">${money(total)} (${s.pieces_total ?? '?'} pieces)</td></tr>
          <tr><td data-label="">Due on delivery</td><td data-label="Due"><strong>${money(balance)}</strong></td></tr>
          <tr><td data-label="">Pickup/delivery location</td><td data-label="Location">${esc(s.delivery_location || '—')}</td></tr>
          <tr><td data-label="">Pieces</td><td data-label="Pieces">${held.map(h => `${h.quantity}× ${esc(h.label)} <span class="pill good">held</span>`).join(', ') || '—'}${shorts.length ? '<br>' + shorts.map(o => `${o.quantity}× ${esc(o.label)} <span class="pill ${o.status === 'open' ? 'warn' : 'good'}">${o.status === 'open' ? (o.fulfillment === 'order' ? `ordering — ${money(o.unit_cost)}/box` : 'waiting on next trip') : 'in'}</span>`).join(', ') : ''}</td></tr>
        </tbody>
      </table>
      <form method="post" action="/deposits/${s.id}/update" style="display:flex;gap:.6rem;flex-wrap:wrap;align-items:center;margin:.7rem 0 0;">
        <label class="field-label" style="margin:0;">Delivering:</label>
        <input type="date" name="delivery_date" value="${esc(s.delivery_date || '')}" style="width:auto;">
        <button type="submit" class="btn" style="padding:.5rem .9rem;background:var(--line);color:var(--ink);">Set date</button>
      </form>
      <div style="display:flex;gap:.6rem;flex-wrap:wrap;margin-top:.7rem;">
        <a class="btn" href="/deposits/${s.id}/complete" style="display:inline-block;text-decoration:none;">✅ Delivered &amp; paid — complete sale</a>
        <form method="post" action="/deposits/${s.id}/cancel" onsubmit="return confirm('Cancel this deposit? The pieces go back into stock and the website will show them available again.');" style="margin:0;">
          <button type="submit" class="btn" style="background:#fbe7e7;color:var(--bad);border:1px solid #f0bcbc;">Cancel &amp; restock</button>
        </form>
      </div>
      <details style="margin-top:.7rem;">
        <summary style="cursor:pointer;font-weight:600;color:var(--muted, #777);">✏️ Edit everything on this deposit</summary>
        <form method="post" action="/deposits/${s.id}/update" style="margin-top:.6rem;">
          <div class="field-block"><label class="field-label">Customer name</label><input type="text" name="customer_name" value="${esc(s.customer_name || '')}"></div>
          <div class="field-block"><label class="field-label">Location of pickup/delivery</label><input type="text" name="delivery_location" value="${esc(s.delivery_location || '')}"></div>
          <div class="field-block"><label class="field-label">Delivery date</label><input type="date" name="delivery_date" value="${esc(s.delivery_date || '')}"></div>
          <div class="field-block"><label class="field-label">Deposit taken date</label><input type="date" name="date" value="${esc(s.date)}"></div>
          <div class="field-block"><label class="field-label">Couch price ($)</label><input type="number" name="base_price" min="0" step="1" inputmode="numeric" value="${s.base_price}"></div>
          <div class="field-block">
            <label class="field-label">Delivery fee ($)</label>
            <input type="number" name="delivery_fee" min="0" step="1" inputmode="numeric" value="${s.delivery_fee || 0}">
            ${buttonGroup(`delivery_by_${s.id}`, [{ value: '', label: 'No delivery' }, 'Dawson', 'Grant', 'Both'], { selected: s.delivery_by || '' }).replace(new RegExp(`name="delivery_by_${s.id}"`, 'g'), 'name="delivery_by"')}
          </div>
          <div class="field-block">
            <label class="field-label">Assembly fee ($)</label>
            <input type="number" name="assembly_fee" min="0" step="1" inputmode="numeric" value="${s.assembly_fee || 0}">
            ${buttonGroup(`assembly_by_${s.id}`, [{ value: '', label: 'No assembly' }, 'Dawson', 'Grant', 'Both'], { selected: s.assembly_by || '' }).replace(new RegExp(`name="assembly_by_${s.id}"`, 'g'), 'name="assembly_by"')}
          </div>
          <div class="field-block"><label class="field-label">Deposit amount ($)</label><input type="number" name="deposit_amount" min="0" step="1" inputmode="numeric" value="${s.deposit_amount || 0}"></div>
          <div class="field-block"><label class="field-label">Notes</label><input type="text" name="notes" value="${esc(s.notes || '')}"></div>
          <button type="submit" class="big-submit">Save changes</button>
        </form>
      </details>
    </div>`;
  }).join('')}

  <h2>📋 Pieces on order</h2>
  <div class="card">
    ${openOrders.length ? `
    <table>
      <thead><tr><th>Piece</th><th>Qty</th><th>How</th><th>For</th><th></th></tr></thead>
      <tbody>${openOrders.map(r => `
        <tr>
          <td data-label="Piece"><span class="swatch-dot" style="background:${colorSwatch(r.color)}"></span>${esc(r.sku)} — ${esc(r.label)} <span class="small muted">${esc(r.full_sku)}</span></td>
          <td data-label="Qty">${r.quantity}</td>
          <td data-label="How">${r.fulfillment === 'order' ? `📦 Ordering — ${money(r.unit_cost)}/box shipped` : '🚚 Waiting on next trip'}</td>
          <td data-label="For">${r.sale_id ? `Sale #${r.sale_id}${r.customer_name ? ' — ' + esc(r.customer_name) : ''}${r.sale_is_hold ? ' <span class="pill warn">deposit</span>' : ''} <span class="small muted">${esc(r.sale_date || '')}</span>` : '—'}</td>
          <td data-label="">
            <form method="post" action="/orders/${r.id}/fulfill" style="margin:0;display:inline;">
              <button type="submit" class="btn" style="padding:.45rem .8rem;font-size:.92rem;">Got it ✓</button>
            </form>
          </td>
        </tr>`).join('')}</tbody>
    </table>
    <p class="small muted" style="margin-bottom:0;">"Got it ✓": ordered pieces log their real ${money(ORDER_PIECE_COST_SHIPPED)}/box cost automatically; next-trip pieces come out of stock (log the trip's boxes in first).</p>
    ` : `<p class="muted small" style="margin:0;">Nothing on order — you're covered.</p>`}
  </div>
  `;
  sendHtml(res, 200, layout({ title: 'Deposits & Orders', user, active: '/deposits', body, wide: true }));
}

// Partial update: only fields present in the form change; everything else
// keeps its saved value (lets the quick "set date" form and the full edit
// form share one endpoint).
async function handleDepositUpdate(req, res, user, saleId) {
  const sale = await db.get(`SELECT * FROM sales WHERE id = ? AND COALESCE(is_deposit_hold,0) = 1`, [saleId]);
  if (!sale) return redirect(res, '/deposits');
  const form = await readForm(req);
  const pick = (key, fallback, num) => {
    if (!(key in form)) return fallback;
    if (num) return parseFloat(form[key] || '0');
    return form[key] === '' ? null : form[key];
  };
  await db.run(`
    UPDATE sales SET date = ?, customer_name = ?, delivery_location = ?, delivery_date = ?,
      base_price = ?, delivery_fee = ?, delivery_by = ?, assembly_fee = ?, assembly_by = ?,
      deposit_amount = ?, notes = ? WHERE id = ?
  `, [
    pick('date', sale.date) || sale.date,
    pick('customer_name', sale.customer_name),
    pick('delivery_location', sale.delivery_location),
    pick('delivery_date', sale.delivery_date),
    pick('base_price', sale.base_price, true),
    pick('delivery_fee', sale.delivery_fee, true),
    'delivery_by' in form ? (form.delivery_by || null) : sale.delivery_by,
    pick('assembly_fee', sale.assembly_fee, true),
    'assembly_by' in form ? (form.assembly_by || null) : sale.assembly_by,
    pick('deposit_amount', sale.deposit_amount, true),
    pick('notes', sale.notes),
    saleId,
  ]);
  await handleDeposits(req, res, user, { text: `Sale #${saleId} updated.` });
}

async function handleDepositCompleteGet(req, res, user, saleId) {
  const sale = await db.get(`SELECT sales.*, products.sku FROM sales LEFT JOIN products ON products.id = sales.product_id WHERE sales.id = ? AND COALESCE(sales.is_deposit_hold,0) = 1`, [saleId]);
  if (!sale) return redirect(res, '/deposits');
  const total = (sale.base_price || 0) + (sale.delivery_fee || 0) + (sale.assembly_fee || 0);

  const body = `
  <a class="back-link" href="/deposits">&larr; Back to deposits</a>
  <h1 class="mt0">Complete sale — ${esc(sale.sku || '')}${sale.customer_name ? ` for ${esc(sale.customer_name)}` : ''}</h1>
  <p class="muted">Deposit of <strong>${money(sale.deposit_amount || 0)}</strong> already in hand — <strong>${money(total - (sale.deposit_amount || 0))}</strong> to collect now (it's part of the same ${money(total)} total, not extra). Adjust anything that changed, then complete it.</p>
  <form method="post" action="/deposits/${saleId}/complete">
    <div class="field-block"><label class="field-label">Delivery / completion date</label><input type="date" name="date" value="${esc(sale.delivery_date || today())}" required></div>
    <div class="field-block"><label class="field-label">Base price ($)</label><input type="number" name="base_price" min="0" step="1" required inputmode="numeric" value="${sale.base_price}"></div>
    <div class="field-block">
      <label class="field-label">Delivery fee ($)</label>
      <input type="number" name="delivery_fee" min="0" step="1" inputmode="numeric" value="${sale.delivery_fee || 0}">
      ${buttonGroup('delivery_by', [{ value: '', label: 'No delivery' }, 'Dawson', 'Grant', 'Both'], { selected: sale.delivery_by || '' })}
    </div>
    <div class="field-block">
      <label class="field-label">Assembly fee ($)</label>
      <input type="number" name="assembly_fee" min="0" step="1" inputmode="numeric" value="${sale.assembly_fee || 0}">
      ${buttonGroup('assembly_by', [{ value: '', label: 'No assembly' }, 'Dawson', 'Grant', 'Both'], { selected: sale.assembly_by || '' })}
    </div>
    <div class="field-block"><label class="field-label">Rest paid how?</label>${buttonGroup('payment_method', ['Cash', 'Venmo', 'Other'], { selected: sale.payment_method })}</div>
    <button type="submit" class="big-submit">Complete the sale 🎉</button>
  </form>
  `;
  sendHtml(res, 200, layout({ title: 'Complete sale', user, active: '/deposits', body }));
}

async function handleDepositCompletePost(req, res, user, saleId) {
  const sale = await db.get(`SELECT * FROM sales WHERE id = ? AND COALESCE(is_deposit_hold,0) = 1`, [saleId]);
  if (!sale) return redirect(res, '/deposits');
  const form = await readForm(req);
  const priorProfit = (await profitSummary()).totalProfit;
  await db.run(`
    UPDATE sales SET date = ?, base_price = ?, delivery_fee = ?, delivery_by = ?, assembly_fee = ?, assembly_by = ?,
      payment_method = ?, payment_status = 'Paid', is_deposit_hold = 0 WHERE id = ?
  `, [
    form.date, parseFloat(form.base_price || '0'), parseFloat(form.delivery_fee || '0'), form.delivery_by || null,
    parseFloat(form.assembly_fee || '0'), form.assembly_by || null, form.payment_method, saleId
  ]);
  const basePriceNum = parseFloat(form.base_price || '0');
  const earnings = partnerEarnings({
    base_price: basePriceNum, delivery_fee: parseFloat(form.delivery_fee || '0'), delivery_by: form.delivery_by,
    assembly_fee: parseFloat(form.assembly_fee || '0'), assembly_by: form.assembly_by,
  });
  const allTimeProfit = (await profitSummary()).totalProfit;
  const body = `
    <div class="notice" style="background:#e3f5ec;border-color:#b9e3cc;color:#0f5c3d;">
      <strong>💰 Sale completed.</strong> Deposit of ${money(sale.deposit_amount || 0)} plus the balance — the full amount now counts as revenue.
    </div>
    <div class="stat-grid">
      <div class="stat-card good"><div class="label">💵 Dawson made</div><div class="value">${money(earnings.Dawson)}</div></div>
      <div class="stat-card good"><div class="label">💵 Grant made</div><div class="value">${money(earnings.Grant)}</div></div>
      <div class="stat-card good"><div class="label">📈 All-time profit now</div><div class="value">${money(allTimeProfit)}</div><div class="small muted">⬆ up ${money(allTimeProfit - priorProfit)} from completing this</div></div>
    </div>
    ${await latestTripCard()}
    <a href="/deposits" class="btn" style="display:inline-block;text-decoration:none;margin-right:.5rem;">Back to deposits</a>
    <a href="/" class="btn" style="display:inline-block;text-decoration:none;background:var(--line);color:var(--ink);">Log another sale</a>
  `;
  sendHtml(res, 200, layout({ title: 'Sale completed', user, active: '/deposits', body }));
}

async function handleDepositCancel(req, res, user, saleId) {
  const sale = await db.get(`SELECT * FROM sales WHERE id = ? AND COALESCE(is_deposit_hold,0) = 1`, [saleId]);
  if (!sale) return redirect(res, '/deposits');
  // Same restore-then-delete as deleting a sale: held pieces go back to stock.
  const items = await db.all(`SELECT * FROM sale_items WHERE sale_id = ?`, [saleId]);
  for (const item of items) {
    await db.run(`
      INSERT INTO inventory (piece_type_id, location, quantity) VALUES (?, ?, ?)
      ON CONFLICT(piece_type_id, location) DO UPDATE SET quantity = quantity + excluded.quantity
    `, [item.piece_type_id, item.location, item.quantity]);
  }
  await db.run(`DELETE FROM sale_items WHERE sale_id = ?`, [saleId]);
  await db.run(`DELETE FROM piece_orders WHERE sale_id = ? AND status = 'open'`, [saleId]);
  await db.run(`DELETE FROM sales WHERE id = ?`, [saleId]);
  syncShowroomInventory().catch(() => {});
  await handleDeposits(req, res, user, { text: 'Deposit cancelled — pieces are back in stock and the website will show them available on the next sync (already kicked off).' });
}

// =============================================================================
// ORDERS — pieces sold beyond what was on hand. Each is either being ordered
// (~$215/box shipped) or waiting on the next trip. Marking one done records
// the cost correctly without double-counting inventory.
// =============================================================================
async function handleOrderFulfill(req, res, user, orderId) {
  const order = await db.get(`SELECT * FROM piece_orders WHERE id = ? AND status = 'open'`, [orderId]);
  if (!order) return redirect(res, '/orders');

  if (order.fulfillment === 'order') {
    // Bought specifically for this customer and handed straight over — record
    // the real cost (feeds profit + avg cost/box) but never touches on-hand
    // inventory, since the piece was already promised out the door.
    await db.run(`
      INSERT INTO inventory_receipts (date, piece_type_id, location, quantity, unit_cost, is_free, trip_id, entered_by, notes, is_historical)
      VALUES (?, ?, ?, ?, ?, 0, NULL, ?, ?, 0)
    `, [today(), order.piece_type_id, order.location, order.quantity, order.unit_cost, user.name,
        `Special-order piece for sale #${order.sale_id ?? '?'} (auto-logged from Orders)`]);
  } else {
    // Came in with the next trip's boxes (which get logged via Trips / Add
    // Inventory as usual) — so hand-off just decrements stock like the sale
    // would have originally.
    await db.run(`UPDATE inventory SET quantity = MAX(0, quantity - ?) WHERE piece_type_id = ? AND location = ?`,
      [order.quantity, order.piece_type_id, order.location]);
  }
  await db.run(`UPDATE piece_orders SET status = 'fulfilled', fulfilled_at = ? WHERE id = ?`, [new Date().toISOString(), orderId]);
  syncShowroomInventory().catch(() => {});
  await handleDeposits(req, res, user, { text: order.fulfillment === 'order'
    ? `Done — ${order.quantity} box(es) logged at ${money(order.unit_cost)}/box so the profit math stays right.`
    : `Done — ${order.quantity} box(es) taken out of stock for the customer.` });
}

async function handleSaleEditPost(req, res, user, saleId) {
  const form = await readForm(req);
  await db.run(`
    UPDATE sales SET date = ?, base_price = ?, delivery_fee = ?, delivery_by = ?, assembly_fee = ?, assembly_by = ?,
      payment_method = ?, payment_status = ?, deposit_amount = ?, notes = ? WHERE id = ?
  `, [
    form.date, parseFloat(form.base_price || '0'), parseFloat(form.delivery_fee || '0'), form.delivery_by || null,
    parseFloat(form.assembly_fee || '0'), form.assembly_by || null, form.payment_method, form.payment_status,
    parseFloat(form.deposit_amount || '0'), form.notes || null, saleId
  ]);
  redirect(res, '/sales');
}

// =============================================================================
// STATS — the deep-dive page: avg sale/box cost, expected inventory value,
// best sellers, model/color breakdowns as charts, per-trip stats, time in
// business, monthly profit + partner split, and who's-logged-what.
// =============================================================================
async function handleStats(req, res, user) {
  const { avg: avgSale, count: saleCount } = await avgSalePrice();
  const rate = await avgCostPerBox();
  const expected = await expectedInventoryValue();
  const sellers = await bestSellers(10);
  const byModel = await salesByModel();
  const byColor = await salesByColor();
  const trips = await perTripStats();
  const { firstDate, months } = await timeInBusiness();
  const profit = await profitSummary();
  const entered = await enteredByBreakdown();

  const body = `
  <h1 class="mt0">Stats</h1>

  <div class="stat-grid">
    <div class="stat-card good"><div class="label">💵 Gross sales, all-time</div><div class="value">${money(profit.totalRevenue)}</div></div>
    <div class="stat-card ${profit.totalProfit >= 0 ? 'good' : 'bad'}"><div class="label">📈 Net profit, all-time</div><div class="value">${money(profit.totalProfit)}</div></div>
    <div class="stat-card"><div class="label">Avg sale price</div><div class="value">${money(avgSale)}</div><div class="small muted">${saleCount} sales</div></div>
    <div class="stat-card"><div class="label">Avg cost / box (buying)</div><div class="value">${money(rate)}</div></div>
    <div class="stat-card good"><div class="label">💰 Expected $ of inventory</div><div class="value">${money(expected.value)}</div><div class="small muted">${expected.totalBoxes} boxes × ${money(expected.rate)} avg sold/box</div></div>
    <div class="stat-card"><div class="label">Time in business</div><div class="value">${months} mo${months === 1 ? '' : 's'}</div><div class="small muted">since ${esc(firstDate || '—')}</div></div>
    <div class="stat-card ${profit.avgMonthlyProfit >= 0 ? 'good' : 'bad'}"><div class="label">📈 Avg monthly net profit</div><div class="value">${money(profit.avgMonthlyProfit)}</div></div>
  </div>

  <div class="card">
    <strong>📈 Net profit split (avg / month)</strong>
    <table style="margin-top:.6rem;">
      <thead><tr><th>Partner</th><th>Avg / month</th><th>All-time</th></tr></thead>
      <tbody>
        <tr><td data-label="Partner">Dawson</td><td data-label="Avg / month">${money(profit.avgMonthlyProfitSplit.Dawson)}</td><td data-label="All-time">${money(profit.allTimeSplit.Dawson)}</td></tr>
        <tr><td data-label="Partner">Grant</td><td data-label="Avg / month">${money(profit.avgMonthlyProfitSplit.Grant)}</td><td data-label="All-time">${money(profit.allTimeSplit.Grant)}</td></tr>
      </tbody>
    </table>
    <p class="small muted">Base price always splits 50/50; delivery/assembly fees go to whoever performed them (or split if "Both"); shared trip + inventory purchase costs are split evenly here since they're paid as a business, not attributed per-partner.</p>
  </div>

  <h2>Best sellers</h2>
  <table>
    <thead><tr><th>Product</th><th>Times sold</th><th>Pieces sold</th><th>Revenue</th></tr></thead>
    <tbody>
      ${sellers.map(s => `<tr><td data-label="Product"><span class="swatch-dot" style="background:${colorSwatch(s.color)}"></span>${esc(s.sku)} — ${esc(colorName(s.color))}</td><td data-label="Times sold">${s.saleCount}</td><td data-label="Pieces sold">${s.piecesSold}</td><td data-label="Revenue">${money(s.revenue)}</td></tr>`).join('')}
    </tbody>
  </table>

  <h2>Sales by model</h2>
  ${barChart(byModel.map(m => ({ label: m.model, value: m.saleCount })))}

  <h2>Sales by color</h2>
  ${pieChart(byColor.map(c => ({ label: colorName(c.color), value: c.saleCount })))}

  <h2>Per-trip stats</h2>
  <table>
    <thead><tr><th>Trip</th><th>Date</th><th>Boxes</th><th>Cost</th><th>Cost/box</th><th>Sets sold</th><th>Gross sales</th><th>Net profit</th></tr></thead>
    <tbody>
      ${trips.slice().reverse().map(t => `
        <tr>
          <td data-label="Trip"><strong>${t.trip_number != null ? 'Trip ' + t.trip_number : '—'}</strong></td>
          <td data-label="Date">${esc(t.date)}</td>
          <td data-label="Boxes">${t.boxes_actual}</td>
          <td data-label="Cost">${money(t.total_cost)}</td>
          <td data-label="Cost/box">${money(t.costPerBox)}</td>
          <td data-label="Sets sold">${t.setsSold}</td>
          <td data-label="Gross sales">${money(t.grossSales)}</td>
          <td data-label="Net profit" class="${t.netProfit >= 0 ? 'good-text' : 'bad-text'}">${money(t.netProfit)}</td>
        </tr>
      `).join('')}
    </tbody>
  </table>
  <p class="small muted">"Sets sold" only counts sales logged with a trip link — historical imports are linked, but new sales made in the app aren't tied to a trip yet, so recent trips will show 0 here even once everything from that trip is sold.</p>

  <h2>Who's logged what</h2>
  <table>
    <thead><tr><th></th><th>Dawson</th><th>Grant</th></tr></thead>
    <tbody>
      <tr><td data-label="">Sales</td><td data-label="Dawson">${entered.sales.Dawson || 0}</td><td data-label="Grant">${entered.sales.Grant || 0}</td></tr>
      <tr><td data-label="">Trips</td><td data-label="Dawson">${entered.trips.Dawson || 0}</td><td data-label="Grant">${entered.trips.Grant || 0}</td></tr>
      <tr><td data-label="">Inventory added</td><td data-label="Dawson">${entered.receipts.Dawson || 0}</td><td data-label="Grant">${entered.receipts.Grant || 0}</td></tr>
    </tbody>
  </table>
  <p class="small muted">Only counts things logged since this switched over from the spreadsheet — historical imports don't have a "who" attached.</p>
  `;
  sendHtml(res, 200, layout({ title: 'Stats', user, active: '/stats', body, wide: true }));
}

// =============================================================================
// BACKUP — downloads the ENTIRE database as one JSON file. This is the
// business's whole record (sales, inventory, trips, receipts), so grab one
// regularly — weekly is plenty — and keep it somewhere safe (email it to
// yourself, drop it in Google Drive, whatever). If the database is ever
// lost, this file has everything needed to rebuild it.
// =============================================================================
async function handleBackup(req, res, user) {
  const tables = await db.all(`SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'`);
  const dump = {
    exported_at: new Date().toISOString(),
    exported_by: user.name,
    app: 'couch-ops',
    tables: {},
  };
  for (const t of tables) {
    // Table names come from sqlite_master itself, not user input — safe to
    // interpolate (identifiers can't be bound as ? parameters in SQL anyway).
    dump.tables[t.name] = await db.all(`SELECT * FROM "${t.name.replace(/"/g, '""')}"`);
  }
  const filename = `couch-ops-backup-${today()}.json`;
  res.writeHead(200, {
    'Content-Type': 'application/json',
    'Content-Disposition': `attachment; filename="${filename}"`,
  });
  res.end(JSON.stringify(dump, null, 1));
}

// --- server --------------------------------------------------------------

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, `http://${req.headers.host}`);
    const pathname = url.pathname;

    if (pathname !== '/' && serveStatic(req, res, pathname)) return;

    if (pathname.startsWith('/uploads/trip-photos/') && req.method === 'GET') {
      const filename = pathname.replace('/uploads/trip-photos/', '');
      const filePath = path.join(UPLOADS_DIR, filename);
      if (!filePath.startsWith(UPLOADS_DIR) || !fs.existsSync(filePath)) { res.writeHead(404); res.end(); return; }
      const ext = path.extname(filePath).toLowerCase();
      const type = { '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png', '.webp': 'image/webp' }[ext] || 'application/octet-stream';
      res.writeHead(200, { 'Content-Type': type });
      fs.createReadStream(filePath).pipe(res);
      return;
    }

    if (pathname === '/login' && req.method === 'GET') {
      return sendHtml(res, 200, loginPage());
    }
    if (pathname === '/login' && req.method === 'POST') {
      const form = await readForm(req);
      const user = (await findUserByName(form.name)) || (await ensureUser(form.name));
      const { token, expires } = await createSession(user.id);
      res.setHeader('Set-Cookie', `session=${token}; HttpOnly; Path=/; Expires=${new Date(expires).toUTCString()}; SameSite=Lax`);
      return redirect(res, '/');
    }
    if (pathname === '/logout' && req.method === 'POST') {
      const cookies = parseCookies(req);
      if (cookies.session) await destroySession(cookies.session);
      res.setHeader('Set-Cookie', 'session=; Path=/; Expires=Thu, 01 Jan 1970 00:00:00 GMT');
      return redirect(res, '/login');
    }

    const user = await currentUser(req);
    if (!user) return redirect(res, '/login');

    if (pathname === '/' && req.method === 'GET') return await handleHome(req, res, user);
    if (pathname === '/dashboard' && req.method === 'GET') return await handleDashboard(req, res, user, url.searchParams);
    if (pathname === '/sync-showroom' && req.method === 'POST') return await handleSyncShowroom(req, res, user);
    if (pathname === '/inventory' && req.method === 'GET') return await handleInventory(req, res, user);
    if (pathname === '/inventory/add' && req.method === 'GET') return await handleAddInventoryPicker(req, res, user);
    if (pathname === '/trips' && req.method === 'GET') return await handleTripsGet(req, res, user);
    if (pathname === '/trips' && req.method === 'POST') return await handleTripsPost(req, res, user);
    if (pathname === '/sales' && req.method === 'GET') return await handleSalesHistory(req, res, user);
    if (pathname === '/deposits' && req.method === 'GET') return await handleDeposits(req, res, user);
    if (pathname === '/orders' && req.method === 'GET') return redirect(res, '/deposits'); // Orders lives on the Deposits page now
    if (pathname === '/stats' && req.method === 'GET') return redirect(res, '/dashboard'); // Stats lives on the Dashboard now
    if (pathname === '/backup' && req.method === 'GET') return await handleBackup(req, res, user);

    let m;
    if ((m = pathname.match(/^\/sale\/(\d+)$/)) && req.method === 'GET') return await handleSaleProduct(req, res, user, parseInt(m[1], 10));
    if ((m = pathname.match(/^\/sale\/(\d+)\/confirm$/)) && req.method === 'GET') return await handleSaleConfirm(req, res, user, parseInt(m[1], 10), url.searchParams);
    if ((m = pathname.match(/^\/sale\/(\d+)$/)) && req.method === 'POST') return await handleSaleSubmit(req, res, user, parseInt(m[1], 10));
    if ((m = pathname.match(/^\/inventory\/add\/(\d+)$/)) && req.method === 'GET') return await handleAddInventoryProduct(req, res, user, parseInt(m[1], 10));
    if ((m = pathname.match(/^\/inventory\/add\/(\d+)$/)) && req.method === 'POST') return await handleAddInventorySubmit(req, res, user, parseInt(m[1], 10));
    if ((m = pathname.match(/^\/inventory\/adjust\/(\d+)$/)) && req.method === 'GET') return await handleAdjustInventoryGet(req, res, user, parseInt(m[1], 10));
    if ((m = pathname.match(/^\/inventory\/adjust\/(\d+)$/)) && req.method === 'POST') return await handleAdjustInventoryPost(req, res, user, parseInt(m[1], 10));
    if ((m = pathname.match(/^\/trips\/(\d+)\/edit$/)) && req.method === 'GET') return await handleTripEditGet(req, res, user, parseInt(m[1], 10));
    if ((m = pathname.match(/^\/trips\/(\d+)\/edit$/)) && req.method === 'POST') return await handleTripEditPost(req, res, user, parseInt(m[1], 10));
    if ((m = pathname.match(/^\/sales\/(\d+)\/edit$/)) && req.method === 'GET') return await handleSaleEditGet(req, res, user, parseInt(m[1], 10));
    if ((m = pathname.match(/^\/sales\/(\d+)\/edit$/)) && req.method === 'POST') return await handleSaleEditPost(req, res, user, parseInt(m[1], 10));
    if ((m = pathname.match(/^\/sales\/(\d+)\/delete$/)) && req.method === 'POST') return await handleSaleDelete(req, res, user, parseInt(m[1], 10));
    if ((m = pathname.match(/^\/deposits\/(\d+)\/complete$/)) && req.method === 'GET') return await handleDepositCompleteGet(req, res, user, parseInt(m[1], 10));
    if ((m = pathname.match(/^\/deposits\/(\d+)\/complete$/)) && req.method === 'POST') return await handleDepositCompletePost(req, res, user, parseInt(m[1], 10));
    if ((m = pathname.match(/^\/deposits\/(\d+)\/cancel$/)) && req.method === 'POST') return await handleDepositCancel(req, res, user, parseInt(m[1], 10));
    if ((m = pathname.match(/^\/deposits\/(\d+)\/update$/)) && req.method === 'POST') return await handleDepositUpdate(req, res, user, parseInt(m[1], 10));
    if ((m = pathname.match(/^\/orders\/(\d+)\/fulfill$/)) && req.method === 'POST') return await handleOrderFulfill(req, res, user, parseInt(m[1], 10));

    res.writeHead(404, { 'Content-Type': 'text/plain' });
    res.end('Not found');
  } catch (err) {
    console.error(err);
    res.writeHead(500, { 'Content-Type': 'text/plain' });
    res.end('Something broke. Check the server log.');
  }
});

server.listen(PORT, () => {
  console.log(`Redefined Couches running at http://localhost:${PORT}`);
});
