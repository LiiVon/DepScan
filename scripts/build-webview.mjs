// 打包 Webview 前端：TS -> media/webview.js（IIFE）+ 复制样式
import { build } from 'esbuild';
import { copyFileSync, mkdirSync, existsSync } from 'fs';
import { dirname, resolve } from 'path';
import { fileURLToPath } from 'url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const production = process.argv.includes('--production');

mkdirSync(resolve(root, 'media'), { recursive: true });

await build({
  entryPoints: [resolve(root, 'webview/main.ts')],
  bundle: true,
  platform: 'browser',
  format: 'iife',
  target: ['chrome100', 'firefox100', 'safari15'],
  outfile: resolve(root, 'media/webview.js'),
  sourcemap: !production,
  minify: production,
  logLevel: 'info'
});

const cssSource = resolve(root, 'webview/styles.css');
if (existsSync(cssSource)) {
  copyFileSync(cssSource, resolve(root, 'media/webview.css'));
  console.log('[build-webview] media/webview.css');
}
