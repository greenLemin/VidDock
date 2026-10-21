import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import zlib from 'node:zlib';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const iconsDir = path.join(root, 'apps', 'extension', 'icons');
const distIconsDir = path.join(root, 'apps', 'extension', 'dist', 'icons');

// --- Precomputed CRC32 Table (IEEE 802.3 standard) ---
const crcTable = new Uint32Array(256);
for (let n = 0; n < 256; n++) {
  let c = n;
  for (let k = 0; k < 8; k++) {
    c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  }
  crcTable[n] = c;
}

function crc32(buf) {
  let crc = 0xffffffff;
  for (let i = 0; i < buf.length; i++) {
    crc = crcTable[(crc ^ buf[i]) & 0xff] ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function makeChunk(type, data) {
  const typeBuf = Buffer.from(type, 'ascii');
  const lenBuf = Buffer.alloc(4);
  lenBuf.writeUInt32BE(data.length, 0);
  const typeAndData = Buffer.concat([typeBuf, data]);
  const crcBuf = Buffer.alloc(4);
  crcBuf.writeUInt32BE(crc32(typeAndData), 0);
  return Buffer.concat([lenBuf, typeAndData, crcBuf]);
}

export function encodePng(width, height, rgbaBuffer) {
  const signature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

  // IHDR: 13 bytes
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // 8-bit depth
  ihdr[9] = 6; // Color type 6 (RGBA)
  ihdr[10] = 0; // Deflate compression
  ihdr[11] = 0; // Filter method 0
  ihdr[12] = 0; // No interlace
  const ihdrChunk = makeChunk('IHDR', ihdr);

  // sRGB chunk: rendering intent 0 (Perceptual)
  const srgbChunk = makeChunk('sRGB', Buffer.from([0]));

  // IDAT: Scanlines with Filter Byte 0 (None)
  const scanlineWidth = 1 + width * 4;
  const rawData = Buffer.alloc(height * scanlineWidth);
  for (let y = 0; y < height; y++) {
    const rowOffset = y * scanlineWidth;
    rawData[rowOffset] = 0; // Filter byte 0
    rgbaBuffer.copy(rawData, rowOffset + 1, y * width * 4, (y + 1) * width * 4);
  }

  const deflated = zlib.deflateSync(rawData, { level: 9 });
  const idatChunk = makeChunk('IDAT', deflated);

  // IEND chunk
  const iendChunk = makeChunk('IEND', Buffer.alloc(0));

  return Buffer.concat([signature, ihdrChunk, srgbChunk, idatChunk, iendChunk]);
}

// --- Software Rasterizer with Apple Aesthetic ---
function createIconRgba(size) {
  const buf = Buffer.alloc(size * size * 4);

  // Apple-inspired Color Stops (Cyan -> Electric Blue -> Deep Violet)
  const c0 = [0, 240, 255]; // #00F0FF
  const c1 = [0, 114, 255]; // #0072FF
  const c2 = [121, 40, 202]; // #7928CA

  function sampleGradient(t) {
    if (t <= 0.45) {
      const f = t / 0.45;
      return [
        Math.round(c0[0] + (c1[0] - c0[0]) * f),
        Math.round(c0[1] + (c1[1] - c0[1]) * f),
        Math.round(c0[2] + (c1[2] - c0[2]) * f),
      ];
    }
    const f = (t - 0.45) / 0.55;
    return [
      Math.round(c1[0] + (c2[0] - c1[0]) * f),
      Math.round(c1[1] + (c2[1] - c1[1]) * f),
      Math.round(c1[2] + (c2[2] - c1[2]) * f),
    ];
  }

  if (size === 16) {
    // Pixel-grid aligned 16x16 icon for crisp menu bar rendering
    for (let y = 0; y < 16; y++) {
      for (let x = 0; x < 16; x++) {
        const offset = (y * 16 + x) * 4;
        // Squircle corner mask
        const corner =
          (x === 0 && (y <= 2 || y >= 13)) ||
          (x === 15 && (y <= 2 || y >= 13)) ||
          (y === 0 && (x <= 2 || x >= 13)) ||
          (y === 15 && (x <= 2 || x >= 13)) ||
          (x === 1 && (y === 1 || y === 14)) ||
          (x === 14 && (y === 1 || y === 14));
        if (corner) continue;

        const t = (x + y) / 30;
        const [r, g, b] = sampleGradient(t);
        buf[offset] = r;
        buf[offset + 1] = g;
        buf[offset + 2] = b;
        buf[offset + 3] = 255;

        // Top Gloss Rim
        if (y === 1 && x >= 3 && x <= 12) {
          buf[offset] = Math.min(255, buf[offset] + 70);
          buf[offset + 1] = Math.min(255, buf[offset + 1] + 70);
          buf[offset + 2] = Math.min(255, buf[offset + 2] + 70);
        }

        // Dock Cradle: Row 12 (columns 3..12), Row 11 (columns 3, 12)
        const isDock = (y === 12 && x >= 3 && x <= 12) || (y === 11 && (x === 3 || x === 12));
        // Arrow Stem: Rows 3..6 (columns 7..8)
        const isStem = y >= 3 && y <= 6 && (x === 7 || x === 8);
        // Arrow Head: Row 7 (col 6..9), Row 8 (col 5..10), Row 9 (col 6..9), Row 10 (col 7..8)
        const isHead =
          (y === 7 && x >= 6 && x <= 9) ||
          (y === 8 && x >= 5 && x <= 10) ||
          (y === 9 && x >= 6 && x <= 9) ||
          (y === 10 && (x === 7 || x === 8));

        if (isDock || isStem || isHead) {
          buf[offset] = 255;
          buf[offset + 1] = 255;
          buf[offset + 2] = 255;
          buf[offset + 3] = 255;
        }
      }
    }
    return buf;
  }

  // Multi-Sample Signed Distance Function (4x4 = 16 sub-pixel samples) for 48x48 and 128x128
  const SAMPLES = 4;
  const radius = size * 0.22;
  const pad = size * 0.06;
  const w = size - pad * 2;
  const h = size - pad * 2;

  function sdRoundRect(px, py, rx, ry, rw, rh, rad) {
    const qx = Math.abs(px - (rx + rw / 2)) - rw / 2 + rad;
    const qy = Math.abs(py - (ry + rh / 2)) - rh / 2 + rad;
    return Math.min(Math.max(qx, qy), 0.0) + Math.hypot(Math.max(qx, 0.0), Math.max(qy, 0.0)) - rad;
  }

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      let alphaSum = 0;
      let glyphSum = 0;
      let gradR = 0;
      let gradG = 0;
      let gradB = 0;

      for (let sy = 0; sy < SAMPLES; sy++) {
        for (let sx = 0; sx < SAMPLES; sx++) {
          const subX = x + (sx + 0.5) / SAMPLES;
          const subY = y + (sy + 0.5) / SAMPLES;

          const dist = sdRoundRect(subX, subY, pad, pad, w, h, radius);
          if (dist <= 0) {
            alphaSum++;
            const t = (subX + subY) / (size * 2);
            const [r, g, b] = sampleGradient(t);
            gradR += r;
            gradG += g;
            gradB += b;

            // Geometry Evaluation: Dock and Arrow
            const cx = size / 2;
            // Arrow Stem: width 12%, y 24% to 52%
            const stemW = size * 0.12;
            const inStem = Math.abs(subX - cx) <= stemW / 2 && subY >= size * 0.24 && subY <= size * 0.52;

            // Arrow Head: triangle from y 46% to 68%
            const headW = size * 0.42;
            const headProgress = (subY - size * 0.46) / (size * 0.22);
            const inHead =
              subY >= size * 0.46 &&
              subY <= size * 0.68 &&
              Math.abs(subX - cx) <= (headW / 2) * (1 - headProgress * 0.85);

            // Dock Cradle: y 74% to 84%
            const dockW = size * 0.58;
            const inDockBase = Math.abs(subX - cx) <= dockW / 2 && subY >= size * 0.74 && subY <= size * 0.84;
            const inDockLip =
              Math.abs(subX - cx) >= dockW / 2 - size * 0.08 &&
              Math.abs(subX - cx) <= dockW / 2 &&
              subY >= size * 0.68 &&
              subY <= size * 0.84;

            if (inStem || inHead || inDockBase || inDockLip) {
              glyphSum++;
            }
          }
        }
      }

      const totalSub = SAMPLES * SAMPLES;
      const coverage = alphaSum / totalSub;
      if (coverage > 0) {
        const offset = (y * size + x) * 4;
        let r = Math.round(gradR / alphaSum);
        let g = Math.round(gradG / alphaSum);
        let b = Math.round(gradB / alphaSum);

        // Top rim specular highlight
        if (y < size * 0.45) {
          const gloss = (1 - y / (size * 0.45)) * 0.22;
          r = Math.min(255, Math.round(r + 255 * gloss));
          g = Math.min(255, Math.round(g + 255 * gloss));
          b = Math.min(255, Math.round(b + 255 * gloss));
        }

        const glyphCoverage = glyphSum / totalSub;
        if (glyphCoverage > 0) {
          // Blend with white glyph
          r = Math.round(r * (1 - glyphCoverage) + 255 * glyphCoverage);
          g = Math.round(g * (1 - glyphCoverage) + 255 * glyphCoverage);
          b = Math.round(b * (1 - glyphCoverage) + 255 * glyphCoverage);
        }

        buf[offset] = r;
        buf[offset + 1] = g;
        buf[offset + 2] = b;
        buf[offset + 3] = Math.round(coverage * 255);
      }
    }
  }

  return buf;
}

export function generateAllIcons(targetDir = iconsDir) {
  fs.mkdirSync(targetDir, { recursive: true });

  const sizes = [16, 48, 128];
  for (const size of sizes) {
    const rgba = createIconRgba(size);
    const png = encodePng(size, size, rgba);
    const outFile = path.join(targetDir, `icon-${size}.png`);
    fs.writeFileSync(outFile, png);
    console.log(`Generated ${path.relative(root, outFile)} (${size}x${size}, ${png.length} bytes)`);
  }
}

// Standalone execution
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  console.log('Generating VidDock branding assets & icons...');
  generateAllIcons(iconsDir);
  if (fs.existsSync(path.join(root, 'apps', 'extension', 'dist'))) {
    generateAllIcons(distIconsDir);
  }
  console.log('Icon generation complete.');
}
