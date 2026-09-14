// Webview 离线自检：语法 + 元素 id 对齐 + 内嵌 JSON 可解析。
// 这类错误（模板字符串生成的 HTML 与前端脚本不匹配）编译期发现不了，只能在运行时表现为"页面空白"。
import { build } from 'esbuild';
import { readFileSync, existsSync, mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { dirname, join, resolve } from 'path';
import { fileURLToPath, pathToFileURL } from 'url';
import vm from 'vm';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const failures = [];

function check(condition, message) {
  if (condition) {
    console.log(`  [PASS] ${message}`);
  } else {
    failures.push(message);
    console.log(`  [FAIL] ${message}`);
  }
}

// --- 1. 前端脚本语法 ---
const scriptPath = resolve(root, 'media/webview.js');
check(existsSync(scriptPath), 'media/webview.js 已生成');
if (existsSync(scriptPath)) {
  const code = readFileSync(scriptPath, 'utf8');
  try {
    new vm.Script(code, { filename: 'webview.js' });
    check(true, 'media/webview.js 语法合法（可被浏览器解析）');
  } catch (err) {
    check(false, `media/webview.js 语法错误: ${err.message}`);
  }
  try {
    new vm.Script(readFileSync(resolve(root, 'media/webview.css'), 'utf8'));
  } catch {
    /* CSS 不做脚本校验 */
  }
}

// --- 2. 渲染 HTML（用真实 i18n 数据）---
const workDir = mkdtempSync(join(tmpdir(), 'depscan-check-'));
const bundled = join(workDir, 'webviewHtml.mjs');
await build({
  entryPoints: [resolve(root, 'src/views/webviewHtml.ts')],
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node18',
  outfile: bundled,
  logLevel: 'error'
});
const mod = await import(pathToFileURL(bundled).href);

const i18n = JSON.parse(readFileSync(resolve(root, 'package.nls.json'), 'utf8'));
i18n['graph.loading'] = '正在加载依赖数据…';
i18n['graph.empty'] = '无数据';
i18n['graph.hint'] = '提示';
for (const key of [
  'graph.depth',
  'graph.direction',
  'graph.both',
  'graph.upstream',
  'graph.downstream',
  'graph.showExternal',
  'graph.cluster',
  'graph.clickToOpen',
  'graph.fit',
  'graph.architecture',
  'graph.refresh',
  'graph.search',
  'graph.focusLabel',
  'graph.viewGraph',
  'graph.viewTree',
  'graph.viewTable',
  'graph.legend',
  'graph.exportPng',
  'graph.exportSvg',
  'graph.exportJson',
  'graph.exportDot',
  'graph.exportMermaid',
  'table.node',
  'table.kind',
  'table.outDeps',
  'table.inDeps',
  'table.file',
  'table.precision',
  'precision.exact',
  'precision.approx',
  'kind.file',
  'edge.includes'
]) {
  if (!(key in i18n)) i18n[key] = key;
}

const html = mod.renderGraphHtml({
  cspSource: 'vscode-webview://test',
  scriptUri: 'https://file+.vscode-resource.vscode-cdn.net/media/webview.js',
  styleUri: 'https://file+.vscode-resource.vscode-cdn.net/media/webview.css',
  nonce: 'testnonce123',
  lang: 'zh-CN',
  title: 'DepScan 依赖图',
  i18n
});

// --- 3. 前端脚本引用的元素 id 必须都在 HTML 里 ---
const mainSource = readFileSync(resolve(root, 'webview/main.ts'), 'utf8');
const idPattern = /el(?:<[^>]*>)?\(\s*'([A-Za-z0-9_-]+)'\s*\)/g;
const usedIds = new Set();
let m;
while ((m = idPattern.exec(mainSource)) !== null) usedIds.add(m[1]);
const htmlIds = new Set([...html.matchAll(/id="([^"]+)"/g)].map((x) => x[1]));

const missing = [...usedIds].filter((id) => !htmlIds.has(id));
check(usedIds.size >= 15, `前端引用了 ${usedIds.size} 个 DOM 元素`);
check(missing.length === 0, `所有引用的元素 id 都存在${missing.length ? `（缺失: ${missing.join(', ')}）` : ''}`);

// 反向检查：HTML 里的 anchor/tab 元素不应是死链（无 JS 引用也无害，但至少要有 id 命名空间）
check(
  [...htmlIds].every((id) => /^[A-Za-z][A-Za-z0-9_-]*$/.test(id)),
  'HTML 中的 id 命名合法'
);

// --- 4. 内嵌 i18n JSON 可解析 ---
const embedded = html.match(/<div id="i18n" hidden>([\s\S]*?)<\/div>/);
check(!!embedded, 'HTML 内嵌 i18n 数据块');
if (embedded) {
  try {
    const parsed = JSON.parse(embedded[1]);
    check(typeof parsed === 'object' && parsed !== null && Object.keys(parsed).length > 10, '内嵌 i18n JSON 可解析且非空');
  } catch (err) {
    check(false, `内嵌 i18n JSON 解析失败: ${err.message}`);
  }
}

// --- 5. CSP 与脚本标签 ---
check(html.includes("script-src 'nonce-testnonce123'"), 'CSP 使用 nonce 限制脚本来源');
check(html.includes('<script nonce="testnonce123" src='), '脚本以外部文件 + nonce 加载（无内联脚本）');
check(!/<script(?![^>]*src)[^>]*>[\s\S]*?\S[\s\S]*?<\/script>/.test(html), '不存在含内容的内联 <script>');
check(html.includes('default-src \'none\''), 'CSP 默认拒绝一切外部资源');

// --- 6. 布局回归守卫 ---
// 曾经踩过：DOM 是 4 行（工具栏/页签/内容/状态），CSS 只声明 3 条轨道且不指定 grid-row，
// 自动排布把 1fr 分给了页签行，画布高度塌成 91px（表现为"图缩成底部一个小点"）。
const css = readFileSync(resolve(root, 'media/webview.css'), 'utf8');
const cssBlock = (selector) => {
  const i = css.indexOf(`\n${selector} {`);
  if (i < 0) return '';
  return css.slice(i, css.indexOf('}', i));
};
const appBlock = cssBlock('#app');
const trackSpec = (appBlock.match(/grid-template-rows:\s*([^;]+);/)?.[1] ?? '').trim();
const trackCount = (trackSpec.match(/minmax\([^)]*\)|auto|[\d.]+fr/g) ?? []).length;
check(trackCount === 4, `#app 声明了 4 条网格轨道（工具栏/页签/内容/状态），实际 ${trackCount} 条`);
for (const [selector, row] of [['#toolbar', 1], ['#tabs', 2], ['main', 3], ['aside', 3], ['#status', 4]]) {
  const block = cssBlock(selector);
  check(
    new RegExp(`grid-row:\\s*${row}`).test(block),
    `${selector} 显式指定 grid-row: ${row}（避免自动排布错位）`
  );
}
check(/min-height:\s*0/.test(cssBlock('main')), 'main 设置 min-height: 0（防止内容把网格行撑破）');

rmSync(workDir, { recursive: true, force: true });

if (failures.length > 0) {
  console.error(`\nWebview 自检失败：${failures.length} 项`);
  process.exit(1);
}
console.log('\nWebview 自检通过');
