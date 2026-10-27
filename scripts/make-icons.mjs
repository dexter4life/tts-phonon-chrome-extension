#!/usr/bin/env node
// Generates the extension icons as self-contained PNGs (RGBA, three sound bars
// on a violet tile) so the repo has no binary assets committed by hand.
import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";

const PROJECT_ROOT = path.resolve(import.meta.dirname, "..");
const OUT_DIR = path.join(PROJECT_ROOT, "icons");
const ICON_SIZES = [16, 32, 48, 128];

const CRC_TABLE = new Uint32Array(256);
for (let n = 0; n < 256; n += 1) {
  let c = n;
  for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  CRC_TABLE[n] = c >>> 0;
}

function crc32(bytes) {
  let c = 0xffffffff;
  for (const b of bytes) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function pngChunk(type, data) {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.byteLength, 0);
  const typeBuffer = Buffer.from(type, "ascii");
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([typeBuffer, data])), 0);
  return Buffer.concat([length, typeBuffer, data, crc]);
}

function renderIcon(size) {
  const pixels = Buffer.alloc(size * size * 4);
  const background = [109, 40, 217]; // violet
  const foreground = [243, 238, 255]; // near-white
  const unit = size / 128;
  const halfWidth = 5 * unit;
  const bars = [
    { centerX: 46, height: 44 },
    { centerX: 64, height: 72 },
    { centerX: 82, height: 56 },
  ];

  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      let color = background;
      for (const bar of bars) {
        if (
          Math.abs(x - bar.centerX * unit) <= halfWidth &&
          Math.abs(y - 64 * unit) <= (bar.height / 2) * unit
        ) {
          color = foreground;
          break;
        }
      }
      const index = (y * size + x) * 4;
      pixels[index] = color[0];
      pixels[index + 1] = color[1];
      pixels[index + 2] = color[2];
      pixels[index + 3] = 255;
    }
  }

  // One filter byte (0 = none) per scanline.
  const raw = Buffer.alloc(size * (1 + size * 4));
  for (let row = 0; row < size; row += 1) {
    pixels.copy(
      raw,
      row * (1 + size * 4) + 1,
      row * size * 4,
      (row + 1) * size * 4,
    );
  }

  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // color type: truecolor with alpha

  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk("IHDR", ihdr),
    pngChunk("IDAT", zlib.deflateSync(raw, { level: 9 })),
    pngChunk("IEND", Buffer.alloc(0)),
  ]);
}

fs.mkdirSync(OUT_DIR, { recursive: true });
for (const size of ICON_SIZES) {
  fs.writeFileSync(path.join(OUT_DIR, `icon-${size}.png`), renderIcon(size));
}
console.log(`Wrote PNG icons (${ICON_SIZES.join(", ")}) to icons/`);
