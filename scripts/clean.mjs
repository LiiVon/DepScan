// 清理构建产物
import { rmSync, existsSync } from 'fs';
import { dirname, resolve } from 'path';
import { fileURLToPath } from 'url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const targets = ['dist', 'out', 'media/webview.js', 'media/webview.css', 'media/webview.js.map', 'engine/build'];

for (const rel of targets) {
  const p = resolve(root, rel);
  if (!existsSync(p)) continue;
  rmSync(p, { recursive: true, force: true });
  console.log(`[clean] ${rel}`);
}
