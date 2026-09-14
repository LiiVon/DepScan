// 生成插件图标 media/icon.png（128x128，纯 Node 实现，不依赖图像库）
import { deflateSync } from 'zlib';
import { mkdirSync, writeFileSync } from 'fs';
import { dirname, resolve } from 'path';
import { fileURLToPath } from 'url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SIZE = 128;

const px = new Uint8Array(SIZE * SIZE * 4);

function blend(x, y, r, g, b, a) {
  if (x < 0 || y < 0 || x >= SIZE || y >= SIZE) return;
  const i = (y * SIZE + x) * 4;
  const sa = a / 255;
  const da = px[i + 3] / 255;
  const oa = sa + da * (1 - sa);
  if (oa === 0) return;
  px[i] = Math.round((r * sa + px[i] * da * (1 - sa)) / oa);
  px[i + 1] = Math.round((g * sa + px[i + 1] * da * (1 - sa)) / oa);
  px[i + 2] = Math.round((b * sa + px[i + 2] * da * (1 - sa)) / oa);
  px[i + 3] = Math.round(oa * 255);
}

function disc(cx, cy, radius, color) {
  const [r, g, b] = color;
  for (let y = Math.floor(cy - radius - 1); y <= cy + radius + 1; y++) {
    for (let x = Math.floor(cx - radius - 1); x <= cx + radius + 1; x++) {
      const d = Math.hypot(x - cx, y - cy);
      if (d <= radius) blend(x, y, r, g, b, 255);
      else if (d <= radius + 1) blend(x, y, r, g, b, Math.round((radius + 1 - d) * 255));
    }
  }
}

function line(x0, y0, x1, y1, width, color) {
  const [r, g, b] = color;
  const steps = Math.ceil(Math.hypot(x1 - x0, y1 - y0) * 2);
  for (let i = 0; i <= steps; i++) {
    const t = i / steps;
    const x = x0 + (x1 - x0) * t;
    const y = y0 + (y1 - y0) * t;
    for (let dy = -width; dy <= width; dy++) {
      for (let dx = -width; dx <= width; dx++) {
        const d = Math.hypot(dx, dy);
        if (d <= width) blend(Math.round(x + dx), Math.round(y + dy), r, g, b, 255);
        else if (d <= width + 1) blend(Math.round(x + dx), Math.round(y + dy), r, g, b, 140);
      }
    }
  }
}

// 背景：圆角深色方块（用圆角矩形 SDF 求覆盖）
const BG = [30, 34, 42];
const R = 24;
const half = SIZE / 2;
for (let y = 0; y < SIZE; y++) {
  for (let x = 0; x < SIZE; x++) {
    const dx = Math.abs(x + 0.5 - half) - (half - R);
    const dy = Math.abs(y + 0.5 - half) - (half - R);
    const dist = Math.hypot(Math.max(dx, 0), Math.max(dy, 0)) + Math.min(Math.max(dx, dy), 0) - R;
    if (dist <= 0) blend(x, y, BG[0], BG[1], BG[2], 255);
    else if (dist <= 1) blend(x, y, BG[0], BG[1], BG[2], Math.round((1 - dist) * 255));
  }
}

// 依赖图：三个节点 + 两条连线（表示双向依赖）
const A = [74, 158, 255];
const B = [56, 193, 114];
const C = [246, 166, 35];
const LINK = [206, 214, 226];

line(38, 34, 86, 64, 2, LINK);
line(86, 64, 38, 96, 2, LINK);

disc(86, 64, 13, A);
disc(38, 34, 10, B);
disc(38, 96, 10, C);
disc(86, 64, 5, [20, 24, 32]);

// PNG 编码
function crc32(buf) {
  let c = ~0;
  for (let i = 0; i < buf.length; i++) {
    c ^= buf[i];
    for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xedb88320 & -(c & 1));
  }
  return ~c >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const typeBuf = Buffer.from(type, 'ascii');
  const crcBuf = Buffer.alloc(4);
  crcBuf.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])), 0);
  return Buffer.concat([len, typeBuf, data, crcBuf]);
}

const ihdr = Buffer.alloc(13);
ihdr.writeUInt32BE(SIZE, 0);
ihdr.writeUInt32BE(SIZE, 4);
ihdr[8] = 8; // bit depth
ihdr[9] = 6; // RGBA
ihdr[10] = 0;
ihdr[11] = 0;
ihdr[12] = 0;

const raw = Buffer.alloc((SIZE * 4 + 1) * SIZE);
for (let y = 0; y < SIZE; y++) {
  raw[y * (SIZE * 4 + 1)] = 0;
  Buffer.from(px.buffer, y * SIZE * 4, SIZE * 4).copy(raw, y * (SIZE * 4 + 1) + 1);
}

const png = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  chunk('IHDR', ihdr),
  chunk('IDAT', deflateSync(raw, { level: 9 })),
  chunk('IEND', Buffer.alloc(0))
]);

mkdirSync(resolve(root, 'media'), { recursive: true });
writeFileSync(resolve(root, 'media/icon.png'), png);
console.log(`[make-icon] media/icon.png (${png.length} bytes)`);
