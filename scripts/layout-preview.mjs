// 离线渲染预览：用真实引擎数据生成一个可直接在浏览器打开的 Webview 页面，
// 用于在不开 VS Code 的情况下验证布局、配色、图例是否正常。
//
// 用法: node scripts/layout-preview.mjs [样本项目] [焦点文件] [深度]
// 产物: engine/build/layout-preview.html
import { spawnSync } from 'child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import { dirname, resolve } from 'path';
import { fileURLToPath, pathToFileURL } from 'url';
import { build } from 'esbuild';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const project = process.argv[2] ?? 'samples/demo';
const focus = process.argv[3] ?? 'src/core/engine.cpp';
const depth = Number(process.argv[4] ?? 2);

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

// 复用真实的 HTML 生成器与 i18n
const workDir = resolve(root, 'engine/build');
mkdirSync(workDir, { recursive: true });
const bundled = resolve(workDir, 'layout-preview-html.mjs');
await build({
  entryPoints: [resolve(root, 'src/views/webviewHtml.ts')],
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node18',
  outfile: bundled,
  logLevel: 'error'
});
const { renderGraphHtml } = await import(pathToFileURL(bundled).href);

const strings = JSON.parse(readFileSync(resolve(root, 'package.nls.json'), 'utf8'));
const i18n = {
  loading: '加载中…',
  empty: '无数据',
  hint: '拖动节点 · 滚轮缩放 · 空白处平移 · 双击节点下钻 · 单击节点跳转源码',
  'graph.depth': '层级 k',
  'graph.direction': '方向',
  'graph.both': '双向',
  'graph.upstream': '被谁依赖',
  'graph.downstream': '依赖了谁',
  'graph.showExternal': '显示项目外符号',
  'graph.cluster': '按目录聚类',
  'graph.clickToOpen': '点击跳转源码',
  'graph.fit': '适应窗口',
  'graph.architecture': '全局架构视图',
  'graph.refresh': '刷新',
  'graph.search': '搜索节点…',
  'graph.focusLabel': '焦点',
  'graph.truncated': '节点过多，仅显示 {n} 个（可减小 k，或用搜索定位）',
  'graph.statsLine': '{n} 个节点 · {e} 条边',
  'graph.viewGraph': '图',
  'graph.viewTree': '树',
  'graph.viewTable': '表格',
  'graph.legend': '图例',
  'graph.exportPng': '导出 PNG',
  'graph.exportSvg': '导出 SVG',
  'graph.exportJson': '导出 JSON',
  'graph.exportDot': '导出 DOT',
  'graph.exportMermaid': '导出 Mermaid',
  'table.node': '节点',
  'table.kind': '类型',
  'table.outDeps': '出依赖',
  'table.inDeps': '入依赖',
  'table.file': '文件',
  'table.precision': '精度',
  'precision.exact': '精确',
  'precision.approx': '近似'
};
const kinds = { file: '文件', function: '函数', class: '类', enum: '枚举', variable: '变量', macro: '宏', target: '构建目标', unknown: '未知' };
const edgeKinds = { includes: '包含', calls: '调用', inherits: '继承', uses: '类型', refs: '引用', links: '链接' };
for (const [k, v] of Object.entries(kinds)) i18n[`kind.${k}`] = v;
for (const [k, v] of Object.entries(edgeKinds)) i18n[`edge.${k}`] = v;

let html = renderGraphHtml({
  cspSource: "'self'",
  scriptUri: '../../media/webview.js',
  styleUri: '../../media/webview.css',
  nonce: 'preview',
  lang: 'zh-CN',
  title: `DepScan 布局预览 · ${rel}`,
  i18n
});

// 预览页：去掉 CSP、注入 vscode api 打桩，并在末尾投递真实的 render 消息
html = html.replace(/<meta http-equiv="Content-Security-Policy"[^>]*>\s*/, '');
html = html.replace(
  '<script nonce="preview"',
  `<script>window.acquireVsCodeApi=function(){return{postMessage:function(){},getState:function(){},setState:function(){}};};</script>
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

const outFile = resolve(workDir, 'layout-preview.html');
writeFileSync(outFile, html, 'utf8');
console.log(`[preview] 焦点: file:${rel}（${depth} 层）`);
console.log(`[preview] 子图: ${sub.nodes.length} 节点 / ${sub.edges.length} 边`);
const kindsUsed = {};
for (const n of sub.nodes) kindsUsed[n.kind] = (kindsUsed[n.kind] ?? 0) + 1;
console.log(`[preview] 节点构成: ${JSON.stringify(kindsUsed)}`);
console.log(`[preview] 页面: ${outFile}`);
console.log(`[preview] 浏览器打开: ${pathToFileURL(outFile).href}`);
