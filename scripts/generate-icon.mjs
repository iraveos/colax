/**
 * Generates the Colax app icon: a blue gradient rounded square with a white
 * lock glyph. Pure node, no image libraries: pixels are drawn into a raw RGBA
 * buffer, encoded to PNG with zlib, and the same PNG is wrapped into an ICO
 * container (PNG-compressed ICO entries work on Vista and later).
 *
 * Kept (rather than run once and deleted) so the icon can be re-rendered at a
 * different size or hue by editing the constants below.
 */
import { writeFileSync } from 'node:fs';
import { deflateSync } from 'node:zlib';

const SIZE = 256;
// Deep blue top-left to brighter blue bottom-right: recognisably blue at 16px,
// where a flat fill would read as black.
const TOP = [37, 99, 235];
const BOTTOM = [29, 58, 168];
const RADIUS = 56;

const crcTable = new Int32Array(256);
for (let n = 0; n < 256; n += 1) {
  let c = n;
  for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  crcTable[n] = c;
}
function crc32(bytes) {
  let c = 0xffffffff;
  for (const b of bytes) c = crcTable[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
function chunk(type, data) {
  const out = new Uint8Array(12 + data.length);
  new DataView(out.buffer).setUint32(0, data.length);
  for (let i = 0; i < 4; i += 1) out[4 + i] = type.charCodeAt(i);
  out.set(data, 8);
  new DataView(out.buffer).setUint32(8 + data.length, crc32(out.subarray(4, 8 + data.length)));
  return out;
}

// Rounded-rect mask + vertical gradient, drawn per pixel.
const px = Buffer.alloc(SIZE * SIZE * 4);
for (let y = 0; y < SIZE; y += 1) {
  for (let x = 0; x < SIZE; x += 1) {
    // Distance outside the rounded corner, for antialiased edges.
    const cx = Math.min(x, SIZE - 1 - x);
    const cy = Math.min(y, SIZE - 1 - y);
    const corner = Math.min(cx, cy);
    let alpha = 255;
    if (cx < RADIUS && cy < RADIUS) {
      const dx = RADIUS - cx;
      const dy = RADIUS - cy;
      const d = Math.sqrt(dx * dx + dy * dy) - RADIUS;
      alpha = d <= 0 ? 255 : d >= 1 ? 0 : Math.round(255 * (1 - d));
    }
    void corner;
    const t = y / (SIZE - 1);
    const i = (y * SIZE + x) * 4;
    px[i] = Math.round(TOP[0] + (BOTTOM[0] - TOP[0]) * t);
    px[i + 1] = Math.round(TOP[1] + (BOTTOM[1] - TOP[1]) * t);
    px[i + 2] = Math.round(TOP[2] + (BOTTOM[2] - TOP[2]) * t);
    px[i + 3] = alpha;
  }
}

function paintRect(x0, y0, x1, y1, r, g, b) {
  for (let y = Math.max(0, y0); y < Math.min(SIZE, y1); y += 1) {
    for (let x = Math.max(0, x0); x < Math.min(SIZE, x1); x += 1) {
      const i = (y * SIZE + x) * 4;
      px[i] = r;
      px[i + 1] = g;
      px[i + 2] = b;
      px[i + 3] = 255;
    }
  }
}
function paintDisc(cx, cy, rad, r, g, b) {
  for (let y = Math.floor(cy - rad - 1); y <= Math.ceil(cy + rad + 1); y += 1) {
    for (let x = Math.floor(cx - rad - 1); x <= Math.ceil(cx + rad + 1); x += 1) {
      if (x < 0 || y < 0 || x >= SIZE || y >= SIZE) continue;
      const d = Math.hypot(x + 0.5 - cx, y + 0.5 - cy);
      if (d > rad + 0.5) continue;
      const cover = d <= rad - 0.5 ? 1 : rad + 0.5 - d;
      const i = (y * SIZE + x) * 4;
      const a = (px[i + 3] / 255) * cover;
      px[i] = Math.round(r * a + px[i] * (1 - a));
      px[i + 1] = Math.round(g * a + px[i + 1] * (1 - a));
      px[i + 2] = Math.round(b * a + px[i + 2] * (1 - a));
      px[i + 3] = Math.round(255 * Math.max(px[i + 3] / 255, cover));
    }
  }
}

// White lock: shackle arc, body, keyhole knocked out in background blue.
const C = SIZE / 2;
const shackleR = 44;
const shackleW = 17;
for (let a = 0; a <= 180; a += 1) {
  const rad = (a * Math.PI) / 180;
  for (let w = -shackleW / 2; w <= shackleW / 2; w += 0.75) {
    paintDisc(C + Math.cos(rad) * (shackleR + w), 118 + Math.sin(rad) * (shackleR + w) * -1, 4.5, 255, 255, 255);
  }
}
paintRect(78, 116, 178, 122, 255, 255, 255); // shackle feet
paintRect(70, 116, 186, 196, 255, 255, 255); // body
paintDisc(C, 148, 13, 29, 78, 180); // keyhole bow
paintRect(Math.round(C) - 5, 156, Math.round(C) + 5, 182, 29, 78, 180); // keyhole stem
// Soften the body's square corners.
for (const [qx, qy, sx, sy] of [[70, 116, 1, 1], [186, 116, -1, 1], [70, 196, 1, -1], [186, 196, -1, -1]]) {
  for (let y = 0; y < 14; y += 1) {
    for (let x = 0; x < 14; x += 1) {
      if (Math.hypot(x - 13, y - 13) > 13) {
        const i = ((qy + y * sy) * SIZE + (qx + x * sx)) * 4;
        if (i >= 0 && i + 3 < px.length) px[i + 3] = 0;
      }
    }
  }
}

// PNG: filter-0 scanlines straight into zlib.
const raw = Buffer.alloc(SIZE * (SIZE * 4 + 1));
for (let y = 0; y < SIZE; y += 1) {
  raw[y * (SIZE * 4 + 1)] = 0;
  px.copy(raw, y * (SIZE * 4 + 1) + 1, y * SIZE * 4, (y + 1) * SIZE * 4);
}
const ihdr = new Uint8Array(13);
const ihdrView = new DataView(ihdr.buffer);
ihdrView.setUint32(0, SIZE);
ihdrView.setUint32(4, SIZE);
ihdr[8] = 8;
ihdr[9] = 6;
const png = Buffer.concat([
  Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
  Buffer.from(chunk('IHDR', ihdr)),
  Buffer.from(chunk('IDAT', new Uint8Array(deflateSync(raw)))),
  Buffer.from(chunk('IEND', new Uint8Array(0))),
]);
writeFileSync(new URL('../public/colax-icon.png', import.meta.url), png);

// ICO: classic multi-size BMP entries (16/32/48/256, 32bpp + alpha).
// PNG-compressed entries are legal but electron-builder's parser chokes on
// them ("Invalid typed array length"), so this writes the old unambiguous
// format: BITMAPINFOHEADER with doubled height, bottom-up BGRA pixels, and an
// all-zero AND mask (alpha channel carries transparency).
function downscale(factor) {
  const s = SIZE / factor;
  const out = Buffer.alloc(s * s * 4);
  for (let y = 0; y < s; y += 1) {
    for (let x = 0; x < s; x += 1) {
      let r = 0, g = 0, b = 0, a = 0;
      for (let dy = 0; dy < factor; dy += 1) {
        for (let dx = 0; dx < factor; dx += 1) {
          const i = ((y * factor + dy) * SIZE + (x * factor + dx)) * 4;
          r += px[i]; g += px[i + 1]; b += px[i + 2]; a += px[i + 3];
        }
      }
      const n = factor * factor;
      const o = (y * s + x) * 4;
      out[o] = Math.round(r / n);
      out[o + 1] = Math.round(g / n);
      out[o + 2] = Math.round(b / n);
      out[o + 3] = Math.round(a / n);
    }
  }
  return { size: s, pixels: out };
}
const entries = [];
for (const target of [256, 48, 32, 16]) {
  const { size: s, pixels } = downscale(SIZE / target);
  const rowBytes = s * 4;
  const andBytes = Math.ceil(s / 32) * 4 * s;
  const header = Buffer.alloc(40);
  header.writeUInt32LE(40, 0);
  header.writeInt32LE(s, 4);
  header.writeInt32LE(s * 2, 8);
  header.writeUInt16LE(1, 12);
  header.writeUInt16LE(32, 14);
  header.writeUInt32LE(0, 16);
  header.writeUInt32LE(rowBytes * s + andBytes, 20);
  // Bottom-up BGRA.
  const body = Buffer.alloc(rowBytes * s + andBytes);
  for (let y = 0; y < s; y += 1) {
    for (let x = 0; x < s; x += 1) {
      const src = (y * s + x) * 4;
      const dst = ((s - 1 - y) * s + x) * 4;
      body[dst] = pixels[src + 2];
      body[dst + 1] = pixels[src + 1];
      body[dst + 2] = pixels[src];
      body[dst + 3] = pixels[src + 3];
    }
  }
  entries.push({ header, body });
}
let icoSize = 6 + 16 * entries.length;
for (const e of entries) icoSize += e.header.length + e.body.length;
const ico = Buffer.alloc(icoSize);
ico.writeUInt16LE(0, 0);
ico.writeUInt16LE(1, 2);
ico.writeUInt16LE(entries.length, 4);
let offset = 6 + 16 * entries.length;
entries.forEach((e, i) => {
  const s = [256, 48, 32, 16][i];
  const o = 6 + 16 * i;
  ico[o] = s === 256 ? 0 : s;
  ico[o + 1] = s === 256 ? 0 : s;
  ico[o + 2] = 0;
  ico[o + 3] = 0;
  ico.writeUInt16LE(1, o + 4);
  ico.writeUInt16LE(32, o + 6);
  ico.writeUInt32LE(e.header.length + e.body.length, o + 8);
  ico.writeUInt32LE(offset, o + 12);
  e.header.copy(ico, offset);
  offset += e.header.length;
  e.body.copy(ico, offset);
  offset += e.body.length;
});
writeFileSync(new URL('../public/colax-icon.ico', import.meta.url), ico);
console.log(`icon written: ${png.length} byte PNG, ${ico.length} byte ICO`);
