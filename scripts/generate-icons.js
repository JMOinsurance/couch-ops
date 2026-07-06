// Generates the iPhone/Android home-screen icons as real PNG files, with no
// image library — just a hand-rolled PNG encoder on top of Node's built-in
// zlib. Draws a simple couch silhouette on a solid accent-color square (iOS
// applies its own rounding/masking to whatever square you give it, so no
// need to round corners here). Run with: node scripts/generate-icons.js
// (Only needs re-running if you want to change the icon design.)

import zlib from 'node:zlib';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const OUT_DIR = path.join(__dirname, '..', 'public', 'icons');
if (!fs.existsSync(OUT_DIR)) fs.mkdirSync(OUT_DIR, { recursive: true });

const BG = [43, 108, 176];   // --accent blue, matches the app's palette
const FG = [246, 245, 243];  // --bg off-white, for the couch silhouette

// --- minimal PNG encoder (RGBA, 8-bit, no interlace) ------------------------
const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
    table[n] = c >>> 0;
  }
  return table;
})();
function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
function chunk(type, data) {
  const typeBuf = Buffer.from(type, 'ascii');
  const lenBuf = Buffer.alloc(4);
  lenBuf.writeUInt32BE(data.length, 0);
  const crcBuf = Buffer.alloc(4);
  crcBuf.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])), 0);
  return Buffer.concat([lenBuf, typeBuf, data, crcBuf]);
}
function encodePng(pixels, width, height) {
  const sig = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  const ihdrData = Buffer.alloc(13);
  ihdrData.writeUInt32BE(width, 0);
  ihdrData.writeUInt32BE(height, 4);
  ihdrData[8] = 8;  // bit depth
  ihdrData[9] = 6;  // color type RGBA
  ihdrData[10] = 0; ihdrData[11] = 0; ihdrData[12] = 0;
  const ihdr = chunk('IHDR', ihdrData);

  const raw = Buffer.alloc((width * 4 + 1) * height);
  for (let y = 0; y < height; y++) {
    const rowStart = y * (width * 4 + 1);
    raw[rowStart] = 0; // filter: none
    pixels.copy(raw, rowStart + 1, y * width * 4, (y + 1) * width * 4);
  }
  const idat = chunk('IDAT', zlib.deflateSync(raw));
  const iend = chunk('IEND', Buffer.alloc(0));
  return Buffer.concat([sig, ihdr, idat, iend]);
}

// --- draw a simple couch icon into an RGBA pixel buffer ---------------------
function drawIcon(size) {
  const pixels = Buffer.alloc(size * size * 4);
  const setPx = (x, y, [r, g, b], a = 255) => {
    if (x < 0 || y < 0 || x >= size || y >= size) return;
    const i = (y * size + x) * 4;
    pixels[i] = r; pixels[i + 1] = g; pixels[i + 2] = b; pixels[i + 3] = a;
  };
  const fillRect = (x0, y0, x1, y1, color, radius = 0) => {
    for (let y = y0; y < y1; y++) {
      for (let x = x0; x < x1; x++) {
        if (radius > 0) {
          // corner rounding check
          const cx = x < x0 + radius ? x0 + radius : x >= x1 - radius ? x1 - radius - 1 : x;
          const cy = y < y0 + radius ? y0 + radius : y >= y1 - radius ? y1 - radius - 1 : y;
          const dx = x - cx, dy = y - cy;
          if ((x < x0 + radius || x >= x1 - radius) && (y < y0 + radius || y >= y1 - radius)) {
            if (dx * dx + dy * dy > radius * radius) continue;
          }
        }
        setPx(x, y, color);
      }
    }
  };

  // background fill
  fillRect(0, 0, size, size, BG);

  const u = size / 512; // unit scale so the design works at any output size

  // Backrest — inset from the arms, sits up top. The natural gap below it
  // (before the seat cushion starts) reads as the seam between the two.
  fillRect(156 * u, 140 * u, 356 * u, 240 * u, FG, 20 * u);
  // Armrests — taller than the seat, shorter than the backrest, flanking it.
  fillRect(96 * u, 180 * u, 160 * u, 372 * u, FG, 18 * u);
  fillRect(352 * u, 180 * u, 416 * u, 372 * u, FG, 18 * u);
  // Seat cushion, between the arms, below the backrest.
  fillRect(156 * u, 270 * u, 356 * u, 372 * u, FG, 16 * u);
  // Base / plinth connecting everything along the bottom.
  fillRect(96 * u, 372 * u, 416 * u, 396 * u, FG, 10 * u);
  // Legs.
  fillRect(112 * u, 396 * u, 136 * u, 420 * u, FG, 4 * u);
  fillRect(376 * u, 396 * u, 400 * u, 420 * u, FG, 4 * u);

  // Thin background-colored seams so the armrests read as distinct from the
  // backrest instead of merging into one solid blob where they overlap.
  fillRect(152 * u, 180 * u, 160 * u, 240 * u, BG);
  fillRect(352 * u, 180 * u, 360 * u, 240 * u, BG);

  return pixels;
}

for (const size of [512, 192, 180]) {
  const png = encodePng(drawIcon(size), size, size);
  const name = size === 180 ? 'apple-touch-icon-180.png' : `icon-${size}.png`;
  fs.writeFileSync(path.join(OUT_DIR, name), png);
  console.log(`Wrote public/icons/${name} (${png.length} bytes)`);
}
