// 生成两个图标产物（纯 Node，不依赖图像库）：
//   media/icon.png        128x128 扩展图标（VS Code / Marketplace 要求 PNG）
//   media/activitybar.svg 24x24 活动栏图标（必须单色 + currentColor，才能跟随主题）
//
// 为什么用代码画而不是塞一张位图：能随时重新生成、任意尺寸、两个产物共用同一套几何，
// 不会出现「PNG 改了、SVG 忘了改」这种漂移。造型就是那只煎蛋。
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

// ── 煎蛋 ──
// 蛋白用极坐标谐波扰动出一个不规则轮廓（手绘感只要几个谐波就够了，不必贴图），
// 蛋黄是两层圆 + 一块高光。坐标都写死在 128 画布上，改造型就改这几个数。
const BLOT = { cx: 64, cy: 68, r: 44 };
function blobRadius(theta) {
  return (
    BLOT.r *
    (1 +
      0.10 * Math.sin(3 * theta + 0.7) +
      0.06 * Math.cos(5 * theta + 1.9) +
      0.035 * Math.sin(7 * theta + 0.3))
  );
}

const WHITE = [246, 242, 233];
for (let y = 0; y < SIZE; y++) {
  for (let x = 0; x < SIZE; x++) {
    const dx = x + 0.5 - BLOT.cx;
    const dy = y + 0.5 - BLOT.cy;
    const d = Math.hypot(dx, dy);
    const edge = blobRadius(Math.atan2(dy, dx));
    // 1.4px 的软边就是抗锯齿：覆盖度直接当 alpha 用
    const cov = Math.min(1, (edge - d) / 1.4);
    if (cov > 0) blend(x, y, WHITE[0], WHITE[1], WHITE[2], Math.round(cov * 255));
  }
}

// 蛋黄：暗边 → 主体 → 高光（后画的盖住先画的）
const YOLK = { cx: 64, cy: 62, r: 23 };
disc(YOLK.cx, YOLK.cy, YOLK.r + 1.5, [206, 143, 38]);
disc(YOLK.cx, YOLK.cy, YOLK.r, [244, 183, 64]);
disc(YOLK.cx - 7, YOLK.cy - 7, 6.5, [255, 214, 128]);

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
console.log(`[make-icon] media/icon.png ${SIZE}x${SIZE} (${png.length} bytes)`);

// ── 活动栏图标：单色 SVG，轮廓与上面共用同一套谐波 ──
// 必须用 currentColor：VS Code 会按主题给活动栏图标上色，写死颜色会在浅色主题下发白。
const SVG_SIZE = 24;
const scale = SVG_SIZE / SIZE;
const cx = BLOT.cx * scale;
const cy = BLOT.cy * scale;
const points = [];
for (let i = 0; i < 96; i++) {
  const theta = (i / 96) * Math.PI * 2;
  const r = blobRadius(theta) * scale;
  points.push(`${(cx + r * Math.cos(theta)).toFixed(2)} ${(cy + r * Math.sin(theta)).toFixed(2)}`);
}
const svg = [
  `<svg xmlns="http://www.w3.org/2000/svg" width="${SVG_SIZE}" height="${SVG_SIZE}" viewBox="0 0 ${SVG_SIZE} ${SVG_SIZE}" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round">`,
  `  <path d="M${points.join('L')}Z" />`,
  `  <circle cx="${(YOLK.cx * scale).toFixed(2)}" cy="${(YOLK.cy * scale).toFixed(2)}" r="${(YOLK.r * scale).toFixed(2)}" fill="currentColor" stroke="none" />`,
  '</svg>',
  ''
].join('\n');
writeFileSync(resolve(root, 'media/activitybar.svg'), svg);
console.log(`[make-icon] media/activitybar.svg (${svg.length} bytes)`);
