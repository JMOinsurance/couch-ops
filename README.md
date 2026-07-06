# Redefined Couches — internal tool

An internal tool for the business, replacing the Google Sheet for the things that were costing the most: an invisible reconciliation gap, invisible "stranded" inventory, no record of what came IN to inventory (only what went out), and a profit split that didn't match how you actually get paid.

The app itself is still just plain Node.js, no framework. The one real dependency now is `@libsql/client`, which talks to a free hosted database (Turso) instead of a local file — that's the change that makes "reachable from your phone, on any wifi or cell data, and from Grant's phone too" possible. **You need to do a one-time database setup before running this** — see "Database setup" right below.

## What's in here

- **Logging a sale** is the home page: search or tap a product, tap a preset ("Costco U", "Big U", "Ultra" — or build your own with +/− buttons), tap where it's coming from, fill in price/payment with big buttons, done. No password — just tap Dawson or Grant. No customer name/phone collected anymore (dropped per request).
- **Adding inventory** — a real flow for logging boxes as they come in, not just an initial import. Pick the product, tap + for each piece that arrived, say whose stock it's going to (yours, the other partner's, or split evenly), set a cost per box (pre-filled with a smart default — $75 normally, $50 for 120WE — always editable since real purchases vary), mark it free if it was a bonus piece, and optionally link it to a trip (leave blank for a random one-off purchase).
- **Inventory**, shown as raw piece counts you can search by SKU ("120BE") or color name ("Beige") — no "how many couches can we sell" guess forced on top of it, since you build too many different configurations for one number to capture that honestly.
- **Trips**, with expected-vs-actual box reconciliation built in (expected is now optional — leave it blank when there's no plan going in), traveler tracking, and photo attachments (compressed client-side, no library needed).
- **Sales history**, a searchable log of everything sold — search by product, color, or who logged it, since logging in as yourself now tracks what you entered vs. what Grant entered.
- **Stats**, the deep-dive page: avg sale price, avg cost/box (blended from trip costs and the new per-piece receipts), "expected $" of inventory on hand (boxes × avg **sale** price/box — what it's worth once sold, not what it cost), best sellers, sales-by-model and sales-by-color charts (hand-rolled SVG, no charting library), per-trip stats (cost/box, revenue so far), time in business, avg monthly profit with the real partner split, and a who's-logged-what breakdown.
- **Dashboard**, the at-a-glance version of the above for a quick daily check.
- The real payout structure: base price splits 50/50 automatically, delivery and assembly fees go to whoever performed them — or split 50/50 if you tap "Both", since that happens too — and inventory decrements/increments automatically from whichever location (Dawson's or Grant's) fulfilled or received it.
- Your full history imported and verified against the original spreadsheet's own totals.

**Not yet built**: customer records, delivery scheduling/calendar, deposit-expiration tracking, weekly/monthly auto-reports.

## Database setup (one-time, do this first)

The app's data now lives in a free hosted database (Turso) instead of a file on your computer, so it needs credentials before it'll start. This only needs to be done once, ever — not per computer, not per deploy.

1. Go to **https://app.turso.tech** in a browser and sign up (GitHub or email login — no credit card needed for the free tier).
2. Once you're in the dashboard, create a new database (there's a "Create Database" button). Any name is fine, e.g. `redefined-couches`. Pick a region close to you; it doesn't matter much for a business tool like this.
3. Once it's created, you need two things from its dashboard page:
   - The **database URL** — looks like `libsql://redefined-couches-yourname.turso.io`.
   - An **auth token** — there's a "Create Token" (or similar) button; it generates a long random string. Copy it right away, since some dashboards only show it once.
4. In the project folder (same place as this README), create a new file named exactly `.env` (there's already a `.env.example` file here showing the format — you can copy it and rename the copy). Put your two values in it like this:
   ```
   TURSO_DATABASE_URL=libsql://redefined-couches-yourname.turso.io
   TURSO_AUTH_TOKEN=the-long-token-you-copied
   ```
5. Save it. That's it — `.env` is already set up to be ignored by git, so this never gets committed or shared, and every script (`npm start`, `npm run reset-db`, etc.) already knows to read it automatically.

If you ever need to move this to a new computer, just recreate that same `.env` file there with the same two values — the actual data stays put on Turso either way, nothing to re-import.

## Running it

Requires Node.js 22.5 or newer, and (new as of the Turso migration) a real `npm install` step now that there's one actual dependency:

```
npm install
npm start
```

Then open `http://localhost:3000` on your phone or computer (same wifi network — or, once this is deployed for real, from anywhere; see "Getting this live" below).  No password — the login screen is just two buttons, Dawson or Grant.

## Re-importing history / starting over

The historical data lives as plain JSON under `data/legacy-export/` (exported once from your old spreadsheet) so it can be re-imported any time without needing the original Excel file:

```
npm run reset-db
```

This wipes every row in the Turso database and rebuilds it from that history. **Do not run this once you're using the app for real, ongoing work** — it deletes anything entered since the import, for both of you, since it's all one shared database now. It's here for testing and for the initial handoff.

## Rules that need your eyes before you trust them

The piece-role rules (which piece number is a required "anchor" vs. an optional add-on) are defined in `src/product-rules.js`. Two product lines are still flagged `UNCONFIRMED`:

- **151 series** — your own words were "I don't know 100 percent." Only piece 1 (the reclining corner) is currently treated as required. No presets exist for this line on purpose — you sell it too many different ways to name, so it's custom-entry only.
- **143** — has 4 piece numbers, so it doesn't match the 121/141/142 pattern, and nobody's described what pieces 2–4 actually are. It's also discontinued (you don't buy this anymore), so it's low-stakes to leave unconfirmed.

(121, 141, and 142 are all confirmed — you gave real preset numbers explicitly covering all three together.)

The app flags unconfirmed lines with a visible "rules unconfirmed" pill anywhere they show up. Once you're sure of the real rules, editing the `pieces` block for that model in `src/product-rules.js` and re-running the app (no rebuild needed) is all it takes.

Also flagged in the data: two historical sales of "151LG" were a confirmed typo, but the intended code wasn't clear — left as its own line with a note rather than guessed into a merge.

## Presets

Starter presets live in `src/preset-seeds.js`. The 121/141/142 (corner/middle/ottoman) and 120/140 (left/right-facing) lines are seeded with your real named configurations: Small L, L, L with double/0 ottoman, Costco U, Big U, Ultra for the corner family; Small L, Standard L, Big U for the facing families. 151 has no presets on purpose — it's custom-entry only. You don't need to touch this file to add more presets, though: hit "Custom" on the sale screen, enter the pieces, and there's a "save this as a preset" field right there — it'll show up as a button for that product from then on.

## Price & cost suggestions

`src/pricing.js` maps total piece count to a suggested starting **sale** price (5 pieces → $1,100, 6 → $1,300, 7 → $1,500, 8 → $1,750). `src/cost.js` maps a product SKU to a suggested **cost per box** when adding inventory ($75 normally, $50 for 120WE). Both are shown as pre-filled starting points, never locked — sale discounts and purchase deals both happen.

## Getting this live (reachable from any wifi or cell data)

The database side of this is already done — Turso (above) is a real hosted database, so the data no longer lives on any one computer. What's left is deploying the Node server itself somewhere always-on, which is the plan: **Vercel**, on its free "Hobby" tier.

A couple of things worth knowing going in, so there are no surprises:

- Vercel's Hobby (free) tier's own terms restrict it to personal, non-commercial use. You already weighed that and decided it's fine for this — flagging it here too since it's written down in one place with everything else.
- This app's existing `server.js` (built-in `node:http`, calling `.listen()`) is something Vercel can run directly as-is — no rewrite into an Express app or an `/api` folder needed. That was a real risk earlier on (a "will we have to redo this later" concern) and it's been checked: it isn't the case.
- Photo uploads currently save to a local folder (`data/uploads/trip-photos/`) on whatever machine runs the server. That works fine locally or on Path A below, but Vercel's filesystem doesn't persist uploads between requests the way a normal server's disk does — this needs a small follow-up (most likely storing photos as a Turso-backed base64 blob, or a small object-storage add-on) before trip photos survive on Vercel specifically. Flagging now so it doesn't come as a surprise once deployed; can be tackled right after the initial deploy is confirmed working.

Deploy steps will be walked through together once you've confirmed `npm install && npm start` works locally against your real Turso database (see "Database setup" above) — that's the next thing to verify before moving to Vercel itself.

**Alternative — a spare computer at home, always on.** Still a valid $0 option if you'd rather not deal with Vercel at all: run this app on any always-on computer (an old laptop, a Raspberry Pi) and pair it with a free tool like Tailscale so you and Grant can reach it from your phones over the internet without opening ports. Nothing about the Turso migration works against this option — it still applies either way, and photo uploads aren't a problem on this path since a real disk persists normally.

## Project layout

```
.env                     — your real Turso credentials (you create this; never committed)
.env.example             — template showing the format .env should have
src/
  db.js                — Turso (libSQL) connection + schema; every call here is async
  product-rules.js     — required-vs-optional piece rules per model line
  preset-seeds.js       — starter preset configs (Costco U, Big U, Ultra, etc.)
  colors.js             — color code -> name/swatch, for search
  configurator.js       — dashboard's out-of-stock check (no longer the main story — see Inventory)
  sale-logic.js         — piece stock + preset lookups used by the sale flow
  product-summary.js    — product list with color name/swatch/total for search & tiles
  cost.js                — cost-per-box suggestions + blended avg cost/box (what boxes cost us)
  payout.js              — partner earnings split math (base 50/50, fees to whoever performed them / Both)
  stats.js                — all the number-crunching for Dashboard + Stats
  charts.js                — hand-rolled SVG bar/pie charts, no charting library
  auth.js                   — login/session handling (no password)
  views.js                   — shared HTML shell + login page + PWA/home-screen tags
  server.js                   — routes / request handling — the whole app in one file on purpose
scripts/
  import-legacy-data.js — one-time historical import (safe to re-run right after reset-db)
  reset-db.js            — wipe every row in Turso + re-import, for testing
data/
  legacy-export/         — your historical data as plain JSON (source of truth for re-imports)
  uploads/trip-photos/   — trip photo uploads (not committed to git; see Vercel note above)
public/
  manifest.json           — PWA manifest (name/icons/colors) for the iPhone "Add to Home Screen" look
  icons/                   — generated app icons
```
