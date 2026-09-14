// 泳道图的离线断言：布局不变量 + SVG 良构与转义 + 页面骨架 + 前端脚本。
//
// 为什么值得写：泳道图是「画出来的」，而画出来的东西一向只能靠肉眼看。
// 但只要把**布局**和**生成 SVG**做成纯函数，就可以在这里把
// 「列会不会重叠」「箭头有没有往左跑的」「文件名里的 & 会不会把 SVG 撑坏」
// 这类问题钉死 —— 剩下的只有「颜色好不好看」，那才是真需要眼睛的部分。
import { build } from 'esbuild';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'fs';
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

const workDir = mkdtempSync(join(tmpdir(), 'depscan-swimlane-'));
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

const swim = await bundle('src/views/swimlane.ts', 'swimlane.mjs');
const htmlMod = await bundle('src/views/swimlaneHtml.ts', 'swimlaneHtml.mjs');
const stringsMod = await bundle('src/views/webviewStrings.ts', 'webviewStrings.mjs');
const zhMod = await bundle('src/i18n/zh.ts', 'zh.mjs');
const enMod = await bundle('src/i18n/en.ts', 'en.mjs');

// --- 最小 XML 良构校验器 -------------------------------------------------
// 不引入依赖：这里要抓的是「数据里的 & / < 把结构撑坏」这一个具体风险，
// 用标签栈 + 文本段的转义检查就足够，也足够快。
const VOID_TAGS = new Set(['br', 'hr', 'img', 'meta', 'link', 'input']);
function xmlProblem(text, label) {
  let body = text
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/<!DOCTYPE[^>]*>/i, '')
    .replace(/<\?[\s\S]*?\?>/g, '')
    .replace(/<style[\s\S]*?<\/style>/gi, '<style/>');
  const bare = /&(?!(amp|lt|gt|quot|apos|#\d+);)/;
  const stack = [];
  const re = /<\/?([A-Za-z_][\w:.-]*)((?:"[^"]*"|'[^']*'|[^>"'])*?)(\/?)>/g;
  let last = 0;
  let m;
  while ((m = re.exec(body))) {
    const between = body.slice(last, m.index);
    if (between.includes('<')) return `${label}：文本里出现未转义的 < （${between.trim().slice(0, 40)}）`;
    if (bare.test(between)) return `${label}：文本里出现未转义的 & （${between.trim().slice(0, 40)}）`;
    if (bare.test(m[0])) return `${label}：标签属性里出现未转义的 & （${m[0].slice(0, 60)}）`;
    last = re.lastIndex;
    const tag = m[1];
    if (m[0].startsWith('</')) {
      if (stack.pop() !== tag) return `${label}：标签不匹配 </${tag}>`;
    } else if (!m[3] && !VOID_TAGS.has(tag)) {
      stack.push(tag);
    }
  }
  if (stack.length) return `${label}：标签未闭合（${stack.join(' > ')}）`;
  return undefined;
}

// --- 造一份像 demo 的路线（文件数 / 步数 / 跨文件都够用）-----------------
const step = (order, parent, name, file, line, extra = {}) => ({
  order,
  parent,
  depth: extra.depth ?? 0,
  newFile: extra.newFile ?? false,
  ambiguous: false,
  candidateTotal: 0,
  id: `func:demo::${name}`,
  kind: 'function',
  name,
  file,
  line,
  column: 1,
  module: '',
  detail: '',
  external: false,
  precision: 'approx',
  ...extra
});

const route = {
  from: 'func:main',
  steps: [
    step(1, 0, 'main', 'src/main.cpp', 6, { newFile: true }),
    step(2, 1, 'setVerbose', 'src/main.cpp', 9),
    step(3, 1, 'Application::start', 'src/app/application.cpp', 9, { newFile: true }),
    step(4, 3, 'config', 'include/demo/config.h', 24, { newFile: true }),
    step(5, 3, 'Engine::run', 'src/core/engine.cpp', 27, { newFile: true, ambiguous: true, candidateTotal: 1 }),
    step(6, 5, 'Panel::render', 'src/ui/panel.cpp', 13, { newFile: true }),
    step(7, 5, 'Registry::size', 'src/core/registry.cpp', 16, { newFile: true })
  ],
  truncated: false,
  frontierNodes: 0,
  frontierFiles: 0,
  maxReachedDepth: 2
};

const layout = swim.layoutSwimlane(route);
const svg = swim.renderSwimlaneSvg(layout);

// --- 1. 泳道 ---
check(layout.lanes.length === 6, `泳道数 = 6 个文件（实际 ${layout.lanes.length}）`);
check(
  layout.lanes.map((l) => l.file).join('|') ===
    'src/main.cpp|src/app/application.cpp|include/demo/config.h|src/core/engine.cpp|src/ui/panel.cpp|src/core/registry.cpp',
  '泳道按**首次进入**的顺序排（先碰到的文件在上面）'
);
check(
  layout.lanes.every((lane) => lane.steps.every((s) => s.laneIndex === lane.index)),
  '每一步都落在自己文件的那条泳道里'
);
const allSteps = layout.lanes.flatMap((l) => l.steps);
check(allSteps.length === route.steps.length, `每一步都画出来了（${allSteps.length} / ${route.steps.length}）`);
check(
  layout.lanes.every((lane) => lane.y >= swim.MARGIN && lane.height === swim.LANE_HEIGHT),
  '泳道纵向不重叠（每条高度一致、依次下移）'
);
check(
  layout.lanes.some((lane) => lane.steps[0].file === 'src/main.cpp' && lane.firstOrder === 1),
  '起点所在的文件在最上面（firstOrder=1）'
);

// --- 2. 列不重叠、宽度随名字变长 ---
const byX = [...allSteps].sort((a, b) => a.x - b.x);
let overlap = false;
for (let i = 1; i < byX.length; i += 1) {
  const gap = byX[i].x - byX[i - 1].x;
  // 容差 1e-6：x 是累加出来的，两条列紧邻时理论值恰好等于两半宽之和，
  // 浮点累加会让它差个 1e-13 —— 拿严格相等去比会误报重叠。
  if (gap < (byX[i].columnWidth + byX[i - 1].columnWidth) / 2 - 1e-6) overlap = true;
}
check(!overlap, '任意两列都不重叠（名字再长也压不到邻居）');
const wide = layout.lanes.flatMap((l) => l.steps).find((s) => s.name === 'Application::start');
const narrow = layout.lanes.flatMap((l) => l.steps).find((s) => s.name === 'config');
check(wide.columnWidth > narrow.columnWidth, '名字越长列越宽（列宽由这一步自己的名字决定）');
check(
  layout.lanes
    .flatMap((l) => l.steps)
    .every((s) => s.label.length <= 25),
  '超长名字会截成 …（而不是画出格子外）'
);

// --- 3. 边 ---
check(layout.edges.length === route.steps.length - 1, `边数 = 步数 - 1（${layout.edges.length} 条）`);
check(
  layout.edges.every((e) => e.toOrder > e.fromOrder),
  '每条边都从先读的步骤指向后读的步骤'
);
check(
  layout.edges.every((e) => {
    const from = allSteps.find((s) => s.order === e.fromOrder);
    const to = allSteps.find((s) => s.order === e.toOrder);
    return to.x > from.x;
  }),
  '箭头一律向右 —— 阅读顺序就是横轴方向'
);
check(layout.crossFileEdges === 5, `跨文件边 5 条（实际 ${layout.crossFileEdges}）`);
check(
  layout.edges.filter((e) => !e.crossFile).length === 1,
  '同文件内的边只有 main → setVerbose 这一条'
);
check(
  layout.edges.find((e) => e.fromOrder === 5 && e.toOrder === 6)?.crossFile === true,
  'engine.cpp → panel.cpp 被标成跨文件（这条正是这张图要讲的事）'
);
const laneSteps = new Map(layout.lanes.map((l) => [l.index, l]));
check(
  layout.edges.every((e) => {
    const from = allSteps.find((s) => s.order === e.fromOrder);
    const to = allSteps.find((s) => s.order === e.toOrder);
    const sameLane = from.laneIndex === to.laneIndex;
    return sameLane ? e.path.includes(' L ') : e.path.includes(' C ');
  }),
  '同泳道画直线、跨泳道画 S 形曲线（曲线用三次贝塞尔）'
);
void laneSteps;

// --- 4. 尺寸与截断 ---
check(layout.width > swim.LANE_LABEL_WIDTH, `画布宽度包含左侧文件名栏（${layout.width}px）`);
check(
  layout.height === swim.MARGIN * 2 + layout.lanes.length * swim.LANE_HEIGHT,
  `画布高度 = 泳道数 × 行高 + 边距（${layout.height}px）`
);
const capped = swim.layoutSwimlane(route, { maxSteps: 3 });
check(
  capped.stepCount === 3 && capped.droppedCount === 4,
  `超过绘图上限时如实报数：画 ${capped.stepCount} 步、未画 ${capped.droppedCount} 步`
);
check(
  capped.edges.every((e) => e.fromOrder <= 3 && e.toOrder <= 3),
  '被截断掉的步骤不会留下悬空的边'
);
const grouped = swim.layoutSwimlane({
  ...route,
  // 引擎的文件级折叠结果：「每个文件只保留首次进入的那一步」
  steps: [route.steps[0], route.steps[2], route.steps[3], route.steps[4], route.steps[5], route.steps[6]].map(
    (s) => ({ ...s, newFile: true })
  )
});
check(
  grouped.lanes.every((lane) => lane.steps.length === 1),
  '文件级折叠后每条泳道只有一步（此时「步号顺序」就是「文件顺序」）'
);

// --- 5. SVG 结构 ---
check(svg.startsWith('<svg '), 'SVG 以 <svg 开头');
check(svg.includes('xmlns="http://www.w3.org/2000/svg"'), '带 xmlns —— 导出成单文件也能直接打开');
check(svg.includes('viewBox='), '带 viewBox —— 缩放时才不会糊');
check(
  (svg.match(/class="ds-step[ "]/g) ?? []).length === route.steps.length,
  `SVG 里的步骤数 = ${route.steps.length}`
);
check(
  (svg.match(/data-file="/g) ?? []).length === route.steps.length,
  '每个圆点都带 data-file（否则点不动、跳不了源码）'
);
check(
  (svg.match(/data-line="/g) ?? []).length === route.steps.length,
  '每个圆点都带 data-line'
);
check(
  (svg.match(/class="ds-lane[ "]/g) ?? []).length === 6,
  'SVG 里的泳道底 = 6 条（奇偶行不同底色，便于区分相邻泳道）'
);
check((svg.match(/class="ds-file"/g) ?? []).length === 6, 'SVG 里的文件名标签 = 6 个');
check(
  (svg.match(/class="ds-edge ds-edge-cross"/g) ?? []).length === layout.crossFileEdges,
  '跨文件边带独立的 class（页面上按它上色）'
);
check(svg.includes('ds-step-ambiguous'), '有同名定义的步骤在 SVG 里也标出来了');
check(svg === swim.renderSwimlaneSvg(layout), '同样输入下 SVG 完全确定（可复现，导出的与显示的一致）');
check(xmlProblem(svg, 'svg') === undefined, `SVG 结构良构${xmlProblem(svg, 'svg') ? `（${xmlProblem(svg, 'svg')}）` : ''}`);

// 样式必须带兜底色：VS Code 里有 --vscode-* 变量，导出成单文件时没有
const cssBlock = /<style>([\s\S]*?)<\/style>/.exec(svg)?.[1] ?? '';
const vars = [...cssBlock.matchAll(/var\(([^)]*)\)/g)].map((m) => m[1]);
check(vars.length > 0, `样式用了 ${vars.length} 处 CSS 变量（跟随 VS Code 主题）`);
check(
  vars.every((v) => v.includes(',')),
  `每个 CSS 变量都带兜底色 —— 导出成单文件也不会变成透明/黑色`
);

// --- 6. 转义：数据里的 & < 不能把 SVG 撑坏 ---
const nasty = {
  ...route,
  from: 'func:main',
  steps: [
    step(1, 0, 'a&b<c"d\'e', 'src/we&ird<path>.cpp', 3, { newFile: true }),
    step(2, 1, 'plain', 'src/main.cpp', 9, { newFile: true })
  ]
};
const nastySvg = swim.renderSwimlaneSvg(swim.layoutSwimlane(nasty));
check(nastySvg.includes('a&amp;b&lt;c&quot;d&apos;e'), '名字里的 & < " \' 被转义');
check(nastySvg.includes('src/we&amp;ird&lt;path&gt;.cpp'), '文件路径里的 & < > 被转义');
check(
  xmlProblem(nastySvg, 'nasty-svg') === undefined,
  `带特殊字符时 SVG 依然良构${xmlProblem(nastySvg, 'nasty-svg') ? `（${xmlProblem(nastySvg, 'nasty-svg')}）` : ''}`
);

// --- 7. 页面骨架 ---
const zh = zhMod.zh;
const en = enMod.en;
const zhStrings = stringsMod.buildSwimlaneStrings(zh);
const enStrings = stringsMod.buildSwimlaneStrings(en);
const zhKeys = Object.keys(zhStrings).sort();
const enKeys = Object.keys(enStrings).sort();
check(zhKeys.length > 10, `泳道图文案共 ${zhKeys.length} 条`);
check(zhKeys.join(',') === enKeys.join(','), '中英文泳道图文案键集合一致');
check(
  zhKeys.every((k) => zhStrings[k] !== k),
  '没有「键名当值」的占位残留'
);
check(
  zhKeys.some((k) => zhStrings[k] !== enStrings[k]) &&
    zhKeys.filter((k) => zhStrings[k] === enStrings[k]).length === 0,
  '中英文文案确实不同'
);

const htmlOptions = {
  cspSource: 'vscode-webview://abc',
  scriptUri: 'vscode-webview://abc/swimlane.js',
  nonce: 'NONCE123',
  lang: 'zh-CN',
  title: '阅读路线 · main',
  status: '7 步 · 6 个文件 · 5 次换文件',
  svg,
  emptyText: '没有路线',
  i18n: zhStrings
};
const html = htmlMod.renderSwimlaneHtml(htmlOptions);
check(html.includes('Content-Security-Policy'), '页面带 CSP');
check(html.includes("script-src 'nonce-NONCE123'"), 'CSP 用 nonce 限制脚本来源');
check(html.includes('src="vscode-webview://abc/swimlane.js"'), '脚本以外部文件加载');
check(!/<script(?![^>]*src=)[^>]*>[\s\S]*?\S[\s\S]*?<\/script>/.test(html), '不存在含内容的内联 <script>');
check(html.includes('xmlns="http://www.w3.org/2000/svg"'), '泳道图被嵌进页面');
check(/<div id="empty"[^>]*hidden/.test(html), '有图时隐藏空态');
check(html.includes('lang="zh-CN"'), '<html lang> 跟随语言');
check(xmlProblem(html, 'html') === undefined, `页面结构良构${xmlProblem(html, 'html') ? `（${xmlProblem(html, 'html')}）` : ''}`);

const emptyHtml = htmlMod.renderSwimlaneHtml({ ...htmlOptions, svg: undefined, emptyText: '还没有可画的路线' });
check(emptyHtml.includes('还没有可画的路线'), '没有路线时显示空态文案');
check(/<div id="viewport"[^>]*hidden/.test(emptyHtml), '没有路线时隐藏画布');
check(!emptyHtml.includes('<svg '), '没有路线时不留一个空 SVG');
const enHtml = htmlMod.renderSwimlaneHtml({ ...htmlOptions, lang: 'en', i18n: enStrings });
check(enHtml !== html && enHtml.includes('Legend'), '英文页面用的是英文文案');

// --- 8. 前端脚本 ---
const scriptPath = resolve(root, 'media/swimlane.js');
check(existsSync(scriptPath), 'media/swimlane.js 已生成');
if (existsSync(scriptPath)) {
  const code = readFileSync(scriptPath, 'utf8');
  try {
    new vm.Script(code, { filename: 'swimlane.js' });
    check(true, 'media/swimlane.js 语法合法（可被浏览器解析）');
  } catch (err) {
    check(false, `media/swimlane.js 语法错误: ${err.message}`);
  }
  check(
    !code.includes('getContext'),
    '页面脚本里没有画布绘制代码（绘制全在插件侧，SVG 由宿主生成）'
  );
  check(code.includes('ds-step'), '页面脚本认得 ds-step（点击跳源码用的）');
  check(
    code.includes('elementFromPoint') && code.includes('finishPan'),
    '点击在 pointerup 里用坐标反查 —— 指针被 setPointerCapture 捕获后，click 委托收不到圆点'
  );

  // 导航：拖拽平移 + 滚轮缩放。这几条只能用浏览器真跑一遍才算数（下面还有一条说明），
  // 但至少先钉住「别哪天把其中一条交互删了」。
  check(code.includes('wheel'), '滚轮处理存在（滚轮缩放）');
  check(
    code.includes('pointerdown') && code.includes('pointermove') && code.includes('pointerup'),
    '指针事件齐全（拖拽平移）'
  );
  check(code.includes('setPointerCapture'), '拖拽时捕获指针（拖出视口也不丢）');
  check(
    code.includes('translate(') && code.includes('scale('),
    '平移与缩放都走 transform（不是改 svg 尺寸 —— 那样做不到以鼠标为锚点缩放）'
  );
  check(code.includes('movedSinceDown'), '区分「拖拽」与「点一下」，拖完不会误跳源码');
  check(code.includes('clampPan'), '平移有边界保护（不会把图拖飞）');
  check(
    code.includes('deltaMode') && code.includes('1.0013'),
    '滚轮缩放量随 deltaY 连续变化（鼠标滚轮一格 ≈1.17 倍，触控板小步才是平滑的）'
  );
}

// 页面骨架里那几条「画布式导航」的样式：不是装饰，缺了就拖不动
check(/cursor:\s*grab/.test(html), '视口光标是抓取手势（能看出这里可以拖）');
check(/touch-action:\s*none/.test(html), '视口声明 touch-action: none（触控/触控板拖拽才不会被浏览器吃掉）');
check(/#viewport\s*\{[^}]*overflow:\s*hidden/.test(html), '视口不靠原生滚动条（改成 transform 平移）');
check(/#canvas\s*\{[^}]*transform-origin/.test(html), '画布声明了 transform-origin: 0 0（缩放原点才对得上）');
check(/<span class="muted">/.test(html), '页面上写了「怎么操作这张图」的提示');

rmSync(workDir, { recursive: true, force: true });

if (failures.length) {
  console.error(`\n[test-swimlane] 失败 ${failures.length} 项`);
  for (const f of failures) console.error(`  - ${f}`);
  process.exit(1);
}
console.log('\n[test-swimlane] 全部通过');
