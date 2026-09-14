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

// 泳道图页面：与依赖图分开打包 —— 它的骨架是固定的，脚本只负责缩放/导出/点击。
// 分开还有一个好处：它不需要 DOM/CSS 自检（里面没有 canvas 绘制代码），
// 而那套自检本来就是为了堵住「画布代码只在浏览器里才出问题」这个坑。
await build({
  entryPoints: [resolve(root, 'webview/swimlane.ts')],
  bundle: true,
  platform: 'browser',
  format: 'iife',
  target: ['chrome100', 'firefox100', 'safari15'],
  outfile: resolve(root, 'media/swimlane.js'),
  sourcemap: !production,
  minify: production,
  logLevel: 'info'
});
