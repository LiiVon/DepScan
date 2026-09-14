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

// --- 2. 用**真实**的 i18n 与 HTML 生成器渲染（不是手写副本）---
const workDir = mkdtempSync(join(tmpdir(), 'depscan-check-'));
const bundle = async (entry, name) => {
  const outfile = join(workDir, name);
  await build({
    entryPoints: [resolve(root, entry)],
    bundle: true,
    platform: 'node',
    format: 'esm',
    target: 'node18',
    outfile,
    logLevel: 'error'
  });
  return import(pathToFileURL(outfile).href);
};

const htmlMod = await bundle('src/views/webviewHtml.ts', 'webviewHtml.mjs');
const stringsMod = await bundle('src/views/webviewStrings.ts', 'webviewStrings.mjs');
const zhMod = await bundle('src/i18n/zh.ts', 'zh.mjs');
const enMod = await bundle('src/i18n/en.ts', 'en.mjs');

const zhStrings = zhMod.zh;
const enStrings = enMod.en;
const i18n = stringsMod.buildWebviewStrings(zhStrings);
const i18nEn = stringsMod.buildWebviewStrings(enStrings);

const html = htmlMod.renderGraphHtml({
  cspSource: 'vscode-webview://test',
  scriptUri: 'https://file+.vscode-resource.vscode-cdn.net/media/webview.js',
  styleUri: 'https://file+.vscode-resource.vscode-cdn.net/media/webview.css',
  nonce: 'testnonce123',
  lang: 'zh-CN',
  title: 'DepScan 依赖图',
  i18n
});

const htmlEn = htmlMod.renderGraphHtml({
  cspSource: 'vscode-webview://test',
  scriptUri: 'https://file+.vscode-resource.vscode-cdn.net/media/webview.js',
  styleUri: 'https://file+.vscode-resource.vscode-cdn.net/media/webview.css',
  nonce: 'testnonce123',
  lang: 'en',
  title: 'DepScan Dependency Graph',
  i18n: i18nEn
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

// --- 7. 中英双语：键集合必须完全一致，且英文字面量真的出现 ---
const flattenKeys = (obj, prefix = '') =>
  Object.entries(obj).flatMap(([k, v]) =>
    v && typeof v === 'object' ? flattenKeys(v, `${prefix}${k}.`) : [`${prefix}${k}`]
  );
const zhKeys = new Set(flattenKeys(zhStrings));
const enKeys = new Set(flattenKeys(enStrings));
const missingInEn = [...zhKeys].filter((k) => !enKeys.has(k));
const missingInZh = [...enKeys].filter((k) => !zhKeys.has(k));
check(zhKeys.size > 60, `中文文案共 ${zhKeys.size} 条`);
check(missingInEn.length === 0, `英文文案无缺键${missingInEn.length ? `（缺 ${missingInEn.join(', ')}）` : ''}`);
check(missingInZh.length === 0, `中文文案无缺键${missingInZh.length ? `（缺 ${missingInZh.join(', ')}）` : ''}`);

const isPlaceholderDump = (arr) => arr.some(([k, v]) => k === v);
check(!isPlaceholderDump(Object.entries(i18n)), '中文 Webview 文案没有"键名当值"的占位残留');
check(!isPlaceholderDump(Object.entries(i18nEn)), '英文 Webview 文案没有"键名当值"的占位残留');
check(i18nEn['graph.viewGraph'] === 'Graph' && i18n['graph.viewGraph'] === '图', '中英文界面文案确实不同');
check(htmlEn.includes('>Graph<') && html.includes('>图<'), '英文/中文 HTML 分别渲染出了对应语言');
check(/<html lang="en"/.test(htmlEn) && /<html lang="zh-CN"/.test(html), '<html lang> 跟随语言切换');

// --- 8. package.nls：默认(英文)与中文翻译的键必须一致，且 package.json 引用的键都存在 ---
const nlsDefault = JSON.parse(readFileSync(resolve(root, 'package.nls.json'), 'utf8'));
const nlsZh = JSON.parse(readFileSync(resolve(root, 'package.nls.zh-cn.json'), 'utf8'));
const nlsKeys = new Set(Object.keys(nlsDefault));
const nlsZhKeys = new Set(Object.keys(nlsZh));
const nlsMissingZh = [...nlsKeys].filter((k) => !nlsZhKeys.has(k));
const nlsExtraZh = [...nlsZhKeys].filter((k) => !nlsKeys.has(k));
check(nlsMissingZh.length === 0, `package.nls.zh-cn.json 无缺键${nlsMissingZh.length ? `（缺 ${nlsMissingZh.join(', ')}）` : ''}`);
check(nlsExtraZh.length === 0, `package.nls.zh-cn.json 无多余键${nlsExtraZh.length ? `（多 ${nlsExtraZh.join(', ')}）` : ''}`);
check(nlsDefault['view.actions'] === 'Actions', 'package.nls.json 是英文默认值（非中文）');

const pkg = JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8'));
const usedNlsKeys = new Set([...JSON.stringify(pkg).matchAll(/%([A-Za-z0-9_.]+)%/g)].map((m) => m[1]));
const danglingKeys = [...usedNlsKeys].filter((k) => !nlsKeys.has(k));
check(usedNlsKeys.size > 20, `package.json 引用了 ${usedNlsKeys.size} 个 nls 键`);
check(danglingKeys.length === 0, `package.json 引用的 nls 键都已定义${danglingKeys.length ? `（缺 ${danglingKeys.join(', ')}）` : ''}`);

rmSync(workDir, { recursive: true, force: true });

if (failures.length > 0) {
  console.error(`\nWebview 自检失败：${failures.length} 项`);
  process.exit(1);
}
console.log('\nWebview 自检通过');
