/**
 * 零依赖 PNG 图标生成：圆角渐变底 + 播放三角，4× 超采样抗锯齿。
 * 产物供 Chrome 扩展使用，构建时自动生成，不需要提交二进制文件。
 */
import { deflateSync } from 'node:zlib';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

export const ICON_SIZES = [16, 32, 48, 128];

const TEAL = [45, 212, 191];
const VIOLET = [139, 92, 246];
const INK = [9, 14, 22];

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let index = 0; index < 256; index += 1) {
    let value = index;
    for (let bit = 0; bit < 8; bit += 1) {
      value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
    }
    table[index] = value >>> 0;
  }
  return table;
})();

function crc32(buffer) {
  let crc = 0xffffffff;
  for (const byte of buffer) crc = CRC_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length, 0);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body), 0);
  return Buffer.concat([length, body, crc]);
}

function encodePng(size, pixels) {
  const stride = size * 4;
  const raw = Buffer.alloc((stride + 1) * size);
  for (let y = 0; y < size; y += 1) {
    raw[y * (stride + 1)] = 0; // filter: none
    pixels.copy(raw, y * (stride + 1) + 1, y * stride, (y + 1) * stride);
  }

  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // color type: RGBA
  ihdr[10] = 0;
  ihdr[11] = 0;
  ihdr[12] = 0;

  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

function insideRoundedSquare(u, v, radius = 0.2) {
  const dx = Math.min(u, 1 - u);
  const dy = Math.min(v, 1 - v);
  if (dx <= 0 || dy <= 0) return false;
  if (dx < radius && dy < radius) {
    const cx = radius - dx;
    const cy = radius - dy;
    return cx * cx + cy * cy <= radius * radius;
  }
  return true;
}

function insideTriangle(u, v) {
  const ax = 0.36;
  const ay = 0.27;
  const bx = 0.36;
  const by = 0.73;
  const cx = 0.74;
  const cy = 0.5;
  const d1 = (u - bx) * (ay - by) - (ax - bx) * (v - by);
  const d2 = (u - cx) * (by - cy) - (bx - cx) * (v - cy);
  const d3 = (u - ax) * (cy - ay) - (cx - ax) * (v - ay);
  const negative = d1 < 0 || d2 < 0 || d3 < 0;
  const positive = d1 > 0 || d2 > 0 || d3 > 0;
  return !(negative && positive);
}

function sample(u, v) {
  if (!insideRoundedSquare(u, v)) return [0, 0, 0, 0];
  if (insideTriangle(u, v)) return [INK[0], INK[1], INK[2], 1];

  const t = Math.min(1, Math.max(0, u * 0.35 + v * 0.65));
  return [
    Math.round(TEAL[0] + (VIOLET[0] - TEAL[0]) * t),
    Math.round(TEAL[1] + (VIOLET[1] - TEAL[1]) * t),
    Math.round(TEAL[2] + (VIOLET[2] - TEAL[2]) * t),
    1,
  ];
}

function render(size) {
  const scale = size <= 16 ? 6 : 4;
  const samples = scale * scale;
  const pixels = Buffer.alloc(size * size * 4);

  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      let red = 0;
      let green = 0;
      let blue = 0;
      let alpha = 0;

      for (let sy = 0; sy < scale; sy += 1) {
        for (let sx = 0; sx < scale; sx += 1) {
          const u = (x * scale + sx + 0.5) / (size * scale);
          const v = (y * scale + sy + 0.5) / (size * scale);
          const [r, g, b, a] = sample(u, v);
          red += r * a;
          green += g * a;
          blue += b * a;
          alpha += a;
        }
      }

      const offset = (y * size + x) * 4;
      if (alpha > 0) {
        pixels[offset] = Math.round(red / alpha);
        pixels[offset + 1] = Math.round(green / alpha);
        pixels[offset + 2] = Math.round(blue / alpha);
      }
      pixels[offset + 3] = Math.round((alpha / samples) * 255);
    }
  }

  return pixels;
}

export async function writeIcons(directory) {
  await mkdir(directory, { recursive: true });
  const written = [];
  for (const size of ICON_SIZES) {
    const png = encodePng(size, render(size));
    const file = join(directory, `icon${size}.png`);
    await writeFile(file, png);
    written.push(file);
  }
  return written;
}
