// 离线渲染预览：用真实引擎数据 + 真实 i18n 生成一个可直接在浏览器打开的 Webview 页面，
// 用于在不开 VS Code 的情况下验证布局、配色、图例与中英文文案。
//
// 用法: node scripts/layout-preview.mjs [样本项目] [焦点文件] [深度] [--lang zh|en]
//   例: node scripts/layout-preview.mjs samples/demo src/core/engine.cpp 2 --lang en
// 产物: engine/build/layout-preview.html（英文为 layout-preview.en.html）
import { spawnSync } from 'child_process';
import { existsSync, mkdirSync, writeFileSync } from 'fs';
import { dirname, resolve } from 'path';
import { fileURLToPath, pathToFileURL } from 'url';
import { build } from 'esbuild';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');

// ---- 参数 ----
const argv = process.argv.slice(2);
const langIndex = argv.indexOf('--lang');
const lang = langIndex >= 0 && argv[langIndex + 1] === 'en' ? 'en' : 'zh';
const positional = argv.filter((a, i) => !a.startsWith('--') && i !== langIndex + 1);
const project = positional[0] ?? 'samples/demo';
const focus = positional[1] ?? 'src/core/engine.cpp';
const depth = Number(positional[2] ?? 2);

const workDir = resolve(root, 'engine/build');
mkdirSync(workDir, { recursive: true });

const bundleModule = async (entry, name) => {
  const outfile = resolve(workDir, `layout-preview-${name}.mjs`);
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

// ---- 扫描真实项目 ----
const exe = process.platform === 'win32' ? '.exe' : '';
const engine = [`engine/build/bin/Release/depscan-core${exe}`, `engine/build/bin/depscan-core${exe}`]
  .map((p) => resolve(root, p))
  .find((p) => existsSync(p));
if (!engine) {
  console.error('[preview] 未找到引擎，请先 npm run build:core');
  process.exit(1);
}
if (!existsSync(resolve(root, project))) {
  console.error(`[preview] 样本项目不存在: ${project}`);
  process.exit(1);
}

const run = spawnSync(engine, ['--once', '--root', resolve(root, project)], {
  encoding: 'buffer',
  maxBuffer: 512 * 1024 * 1024
});
if (run.status !== 0) {
  console.error(`[preview] 扫描失败: ${run.stderr?.toString('utf8')}`);
  process.exit(1);
}
const payload = JSON.parse(run.stdout.toString('utf8'));
const graph = payload.graph;

// 复刻引擎服务端 k 层 BFS（含「文件 ⇄ 内部符号」的结构包含关系）
function subgraph(g, focusId, hops) {
  const byId = new Map(g.nodes.map((n) => [n.id, n]));
  if (!byId.has(focusId)) return { nodes: [], edges: [] };
  const out = new Map();
  const inc = new Map();
  const fileSymbols = new Map();
  for (const e of g.edges) {
    if (!out.has(e.from)) out.set(e.from, []);
    out.get(e.from).push(e.to);
    if (!inc.has(e.to)) inc.set(e.to, []);
    inc.get(e.to).push(e.from);
  }
  for (const n of g.nodes) {
    if (n.kind === 'file' || !n.file) continue;
    if (!fileSymbols.has(n.file)) fileSymbols.set(n.file, []);
    fileSymbols.get(n.file).push(n.id);
  }
  const visited = new Set([focusId]);
  let frontier = [focusId];
  for (let d = 0; d < hops; d++) {
    const next = [];
    for (const id of frontier) {
      const node = byId.get(id);
      const cand = [];
      if (node && node.kind === 'file') cand.push(...(fileSymbols.get(node.file) ?? []));
      else if (node && node.file) cand.push(`file:${node.file}`);
      cand.push(...(out.get(id) ?? []), ...(inc.get(id) ?? []));
      for (const c of cand) {
        if (visited.has(c) || !byId.has(c)) continue;
        visited.add(c);
        next.push(c);
      }
    }
    frontier = next;
  }
  return {
    nodes: [...visited].map((id) => byId.get(id)),
    edges: g.edges.filter((e) => visited.has(e.from) && visited.has(e.to))
  };
}

const rel = focus.replace(/\\/g, '/');
const sub = subgraph(graph, `file:${rel}`, depth);
if (sub.nodes.length === 0) {
  console.error(`[preview] 焦点 "${rel}" 不在图中。可用的 file 节点示例：`);
  console.error(graph.nodes.filter((n) => n.kind === 'file').slice(0, 8).map((n) => `  ${n.file}`).join('\n'));
  process.exit(1);
}

// ---- 复用真实的 HTML 生成器与文案 ----
const { renderGraphHtml } = await bundleModule('src/views/webviewHtml.ts', 'html');
const { buildWebviewStrings } = await bundleModule('src/views/webviewStrings.ts', 'strings');
const zhMod = await bundleModule('src/i18n/zh.ts', 'zh');
const enMod = await bundleModule('src/i18n/en.ts', 'en');
const strings = lang === 'en' ? enMod.en : zhMod.zh;
const i18n = buildWebviewStrings(strings);

let html = renderGraphHtml({
  cspSource: "'self'",
  scriptUri: '../../media/webview.js',
  styleUri: '../../media/webview.css',
  nonce: 'preview',
  lang: lang === 'en' ? 'en' : 'zh-CN',
  title: strings.graph.title(`${rel} [${lang}]`),
  i18n
});

// 预览页：去掉 CSP、注入 vscode api 打桩，并在末尾投递真实的 render 消息
html = html.replace(/<meta http-equiv="Content-Security-Policy"[^>]*>\s*/, '');
html = html.replace(
  '<script nonce="preview"',
  `<script>window.acquireVsCodeApi=function(){return{postMessage:function(m){(window.__posted=window.__posted||[]).push(m);},getState:function(){},setState:function(){}};};</script>
<script nonce="preview"`
);
const settings = {
  depth,
  direction: 'both',
  showExternal: false,
  cluster: false,
  clickToOpen: false,
  focusId: `file:${rel}`,
  label: rel,
  stats: payload.stats
};
html = html.replace(
  '</body>',
  `<script>
window.postMessage({type:'render',graph:${JSON.stringify(sub)},settings:${JSON.stringify(settings)},truncated:false},'*');
</script>
</body>`
);

const outFile = resolve(workDir, lang === 'en' ? 'layout-preview.en.html' : 'layout-preview.html');
writeFileSync(outFile, html, 'utf8');
console.log(`[preview] 语言: ${lang}`);
console.log(`[preview] 焦点: file:${rel}（${depth} 层）`);
console.log(`[preview] 子图: ${sub.nodes.length} 节点 / ${sub.edges.length} 边`);
const kindsUsed = {};
for (const n of sub.nodes) kindsUsed[n.kind] = (kindsUsed[n.kind] ?? 0) + 1;
console.log(`[preview] 节点构成: ${JSON.stringify(kindsUsed)}`);
console.log(`[preview] 浏览器打开: ${pathToFileURL(outFile).href}`);
