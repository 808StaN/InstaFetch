// generate-icons.js — Run with Node.js to create extension icons
// Usage: node generate-icons.js

const { createCanvas } = (() => {
  try {
    return require("canvas");
  } catch {
    return { createCanvas: null };
  }
})();

const fs = require("fs");
const path = require("path");

// If 'canvas' package is not available, generate minimal valid PNGs manually
function createMinimalPNG(size) {
  // Creates a simple solid-color PNG with a down-arrow icon
  // This is a minimal valid PNG file generator

  const width = size;
  const height = size;

  // Create raw pixel data (RGBA)
  const pixels = Buffer.alloc(width * height * 4);

  const centerX = width / 2;
  const centerY = height / 2;
  const radius = width * 0.42;

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const idx = (y * width + x) * 4;
      const dx = x - centerX;
      const dy = y - centerY;
      const dist = Math.sqrt(dx * dx + dy * dy);

      if (dist <= radius) {
        // Inside circle: gradient from #e94560 to #c23152
        const t = dist / radius;
        const r = Math.round(233 * (1 - t * 0.2));
        const g = Math.round(69 * (1 - t * 0.3));
        const b = Math.round(96 * (1 - t * 0.1));

        // Draw a simple down arrow in the center
        const arrowWidth = radius * 0.6;
        const arrowTop = centerY - radius * 0.35;
        const arrowBottom = centerY + radius * 0.25;
        const arrowTipY = centerY + radius * 0.5;
        const stemWidth = radius * 0.2;

        const inStem =
          Math.abs(dx) <= stemWidth && y >= arrowTop && y <= arrowBottom;
        const arrowRelY = y - arrowBottom;
        const arrowHalfW =
          arrowWidth * (1 - arrowRelY / (arrowTipY - arrowBottom));
        const inHead =
          y >= arrowBottom && y <= arrowTipY && Math.abs(dx) <= arrowHalfW;

        if (inStem || inHead) {
          // Arrow: white
          pixels[idx] = 255;
          pixels[idx + 1] = 255;
          pixels[idx + 2] = 255;
          pixels[idx + 3] = 255;
        } else {
          pixels[idx] = r;
          pixels[idx + 1] = g;
          pixels[idx + 2] = b;
          pixels[idx + 3] = 255;
        }
      } else if (dist <= radius + 1) {
        // Anti-aliased edge
        const alpha = Math.round(255 * Math.max(0, 1 - (dist - radius)));
        pixels[idx] = 233;
        pixels[idx + 1] = 69;
        pixels[idx + 2] = 96;
        pixels[idx + 3] = alpha;
      } else {
        // Outside: transparent
        pixels[idx] = 0;
        pixels[idx + 1] = 0;
        pixels[idx + 2] = 0;
        pixels[idx + 3] = 0;
      }
    }
  }

  return encodePNG(width, height, pixels);
}

function encodePNG(width, height, pixels) {
  // Minimal PNG encoder
  const signature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);

  // IHDR
  const ihdrData = Buffer.alloc(13);
  ihdrData.writeUInt32BE(width, 0);
  ihdrData.writeUInt32BE(height, 4);
  ihdrData[8] = 8; // bit depth
  ihdrData[9] = 6; // color type: RGBA
  ihdrData[10] = 0; // compression
  ihdrData[11] = 0; // filter
  ihdrData[12] = 0; // interlace
  const ihdr = createChunk("IHDR", ihdrData);

  // IDAT - raw pixel data with filter byte per row
  const rawData = Buffer.alloc(height * (1 + width * 4));
  for (let y = 0; y < height; y++) {
    rawData[y * (1 + width * 4)] = 0; // filter: None
    pixels.copy(
      rawData,
      y * (1 + width * 4) + 1,
      y * width * 4,
      (y + 1) * width * 4,
    );
  }

  const compressed = deflateRaw(rawData);
  const idat = createChunk("IDAT", compressed);

  // IEND
  const iend = createChunk("IEND", Buffer.alloc(0));

  return Buffer.concat([signature, ihdr, idat, iend]);
}

function createChunk(type, data) {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length, 0);
  const typeBuffer = Buffer.from(type, "ascii");
  const crcData = Buffer.concat([typeBuffer, data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(crcData), 0);
  return Buffer.concat([length, typeBuffer, data, crc]);
}

function deflateRaw(data) {
  const zlib = require("zlib");
  return zlib.deflateSync(data);
}

function crc32(buf) {
  let crc = 0xffffffff;
  const table = new Uint32Array(256);

  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let j = 0; j < 8; j++) {
      c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    table[i] = c;
  }

  for (let i = 0; i < buf.length; i++) {
    crc = table[(crc ^ buf[i]) & 0xff] ^ (crc >>> 8);
  }

  return (crc ^ 0xffffffff) >>> 0;
}

// Generate icons
const iconsDir = path.join(__dirname, "icons");
if (!fs.existsSync(iconsDir)) {
  fs.mkdirSync(iconsDir, { recursive: true });
}

[16, 48, 128].forEach((size) => {
  const png = createMinimalPNG(size);
  const filePath = path.join(iconsDir, `icon${size}.png`);
  fs.writeFileSync(filePath, png);
  console.log(`Created ${filePath} (${png.length} bytes)`);
});

console.log("Done! Icons generated successfully.");
