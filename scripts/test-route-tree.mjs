// 阅读路线视图的**树结构**离线断言。
//
// 为什么需要它：TreeView 的真实渲染只能在有 UI 的扩展宿主里肉眼看，而肉眼
// 恰恰看不出「有候选的步骤忘了可展开」这类错 —— 候选那一行会静静地点不出来。
// 所以把结构抽成纯函数（src/views/routeTreeModel.ts），在这里用固定数据喂它，
// 把「点开一步下面应该出现什么」变成可断言的东西。
import { build } from 'esbuild';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { dirname, join, resolve } from 'path';
import { fileURLToPath, pathToFileURL } from 'url';

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

const workDir = mkdtempSync(join(tmpdir(), 'depscan-route-tree-'));
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

const model = await bundle('src/views/routeTreeModel.ts', 'routeTreeModel.mjs');

const step = (order, parent, name, file, line, extra = {}) => ({
  order,
  parent,
  depth: extra.depth ?? 1,
  newFile: false,
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
  bodyLines: 0,
  ...extra
});

const candidate = (name, file, line) => ({
  id: `func:demo::${name}`,
  name,
  file,
  line,
  column: 1,
  declaration: false,
  detail: ''
});

// 形状照 demo：main 有两个可读入口，run 下 step6 有候选但**没有子步骤**（回归点）
const result = {
  from: 'func:main',
  steps: [
    step(1, 0, 'main', 'src/main.cpp', 6, {
      depth: 0,
      newFile: true,
      ambiguous: true,
      candidateTotal: 1,
      bodyLines: 6,
      skipped: ['setVerbose'],
      candidates: [candidate('wmain', 'src/wmain.cpp', 3)]
    }),
    step(2, 1, 'start', 'src/app/application.cpp', 9, { newFile: true }),
    step(3, 2, 'run', 'src/core/engine.cpp', 27, { depth: 2, newFile: true }),
    step(4, 3, 'describe', 'src/core/engine.cpp', 23, {
      depth: 3,
      ambiguous: true,
      candidateTotal: 2,
      candidates: [
        candidate('Base::describe', 'src/core/base.h', 25),
        candidate('Other::describe', 'src/other.cpp', 11)
      ]
    }),
    step(5, 4, 'trim', 'src/util/string_utils.cpp', 7, { depth: 4 }),
    step(6, 3, 'size', 'src/core/registry.cpp', 16, {
      depth: 3,
      ambiguous: true,
      candidateTotal: 25, // 截断：实际只列出 2 个
      candidates: [
        candidate('Panel::size', 'src/ui/panel.cpp', 21),
        candidate('Base::size', 'src/core/base.h', 31)
      ]
    })
  ],
  truncated: false,
  frontierNodes: 0,
  frontierFiles: 0,
  maxReachedDepth: 4,
  skippedCount: 1
};

const tree = model.buildRouteTree(result);
const noOverrides = new Map();

// --- 1. 根层 ---
const roots = model.treeChildren(tree, undefined, noOverrides);
check(roots.length === 2, `根层 = 1 个根步骤 + 1 条尾行（实际 ${roots.length} 项）`);
check(roots[0].kind === 'step' && roots[0].step.order === 1, '第一项是起点 main');
check(roots[1].kind === 'tail' && roots[1].icon === 'check', '尾行说明「路线已完整生成」');

// --- 2. 「有候选就必须可展开」—— 这是最容易漏的一条 ---
const runChildren = model.treeChildren(tree, { kind: 'step', step: result.steps[2], expandable: true }, noOverrides);
const sizeNode = runChildren.find((n) => n.kind === 'step' && n.step.order === 6);
check(!!sizeNode, 'run 下的 size 出现在子节点里');
check(
  sizeNode?.expandable === true,
  'size 没有子步骤但有候选 —— 仍然必须可展开（否则候选点不出来）'
);
check(
  runChildren.filter((n) => n.kind === 'candidates').length === 0,
  '候选分组挂在「有同名定义的那一步」下面，而不是挂在它的父节点上'
);

const describeChildren = model.treeChildren(
  tree,
  { kind: 'step', step: result.steps[3], expandable: true },
  noOverrides
);
const trimNode = describeChildren.find((n) => n.kind === 'step');
check(trimNode?.expandable === false, 'trim 没有子步骤也没有候选 —— 不可展开（不显示展开箭头）');
check(
  describeChildren.at(-1).kind === 'candidates',
  'describe 既有子步骤又有候选时，候选分组排在子步骤后面'
);

// 只挂候选、没有子步骤的步骤：子节点就是候选分组这一项
const sizeChildren = model.treeChildren(tree, sizeNode, noOverrides);
check(
  sizeChildren.length === 1 && sizeChildren[0].kind === 'candidates',
  `size 下面只有候选分组（实际 ${sizeChildren.length} 项）`
);
check(
  /25/.test(sizeChildren[0].text),
  '候选分组标题报的是 candidateTotal（25），不是实际列出的 2 个'
);

// --- 3. 候选分组的子节点 ---
const sizeCandidates = model.treeChildren(
  tree,
  { kind: 'candidates', step: result.steps[5], text: '', tooltip: '' },
  noOverrides
);
check(
  sizeCandidates.length === 3,
  `候选分组 = 1 个「当前」 + 2 个候选（实际 ${sizeCandidates.length} 项）`
);
const [current, ...others] = sizeCandidates;
check(current.kind === 'candidate' && current.isCurrent === true, '第一项是「当前」用的那一个');
check(current.candidate.id === result.steps[5].id, '「当前」那一项的 id 就是这一步的节点 id');
check(
  current.args.reset === true && current.args.nodeId === '',
  '点「当前」= 撤回纠偏（reset），不是又选一次它自己'
);
check(
  others.every((n) => n.isCurrent === false && n.args.reset === false),
  '其余候选点了就是改用它（reset=false）'
);
check(
  others.every((n) => n.args.nodeId === n.candidate.id),
  '其余候选的 args.nodeId 就是候选自己的 id'
);
check(
  sizeCandidates.every((n) => n.args.parentId === 'func:demo::run' && n.args.name === 'size'),
  'args 里带的是**父节点 id + 简单名**，与引擎 applyOverrides 的 key 对齐'
);
check(
  others.every((n) => n.candidate.file && n.candidate.line > 0),
  '每个候选都带文件位置（列表里要显示 file:line，也便于核对）'
);

// --- 4. 根步骤也有候选：parentId 为空 = 改的是起点 ---
const mainCandidates = model.treeChildren(
  tree,
  { kind: 'candidates', step: result.steps[0], text: '', tooltip: '' },
  noOverrides
);
check(
  mainCandidates.length === 2 && mainCandidates.every((n) => n.args.parentId === ''),
  '起点的候选 parentId 为空 —— 命令据此把候选当成「换个起点」而不是纠偏'
);
check(
  mainCandidates[1].args.nodeId === 'func:demo::wmain',
  `起点的候选指向 ${mainCandidates[1].args.nodeId}`
);

// --- 5. 纠偏 key 是与引擎的硬约定 ---
check(
  model.overrideKey('func:demo::run', 'size') === 'func:demo::run|size',
  'overrideKey 的分隔符与引擎一致（engine/src/route.cpp 的 pid + "|" + name）'
);

// --- 6. 已纠偏时「当前」那一项的说明要变成「点它撤回」 ---
const corrected = new Map([[model.overrideKey('func:demo::run', 'size'), 'func:demo::Panel::size']]);
const correctedCurrent = model.treeChildren(
  tree,
  { kind: 'candidates', step: result.steps[5], text: '', tooltip: '' },
  corrected
)[0];
const plainCurrent = sizeCandidates[0];
check(
  correctedCurrent.candidate.detail !== plainCurrent.candidate.detail,
  '有纠偏时「当前」那一项换成撤回提示（否则用户不知道还能回去）'
);

// --- 7. 截断 ---
const truncated = model.buildRouteTree({ ...result, truncated: true, frontierNodes: 7, frontierFiles: 3 });
const truncatedTail = model.treeChildren(truncated, undefined, noOverrides).at(-1);
check(truncatedTail.icon === 'ellipsis', '被截断时尾行是省略号而不是勾');
check(/7/.test(truncatedTail.text) && /3/.test(truncatedTail.text), '截断尾行报出未展开的节点数与文件数');

// --- 8. 文件级折叠后仍然只有一个根 ---
const folded = model.buildRouteTree({
  ...result,
  steps: [result.steps[0], result.steps[1], result.steps[2], result.steps[3], result.steps[4]].map((s) => ({
    ...s,
    newFile: true
  }))
});
const foldedRoots = model.treeChildren(folded, undefined, noOverrides);
check(
  foldedRoots.filter((n) => n.kind === 'step').length === 1,
  '折叠（文件级）后仍然只有一个根 —— 悬空的父节点不会冒出来'
);

// --- 9. 统计与空态 ---
check(tree.riskyCount === 3, `有同名定义的步骤计数 = 3（实际 ${tree.riskyCount}）`);
check(
  model.needIndexNode().kind === 'info' && typeof model.needIndexNode().text === 'string',
  '未索引时给出可点击的提示行'
);
check(
  model.noEntryNode().kind === 'info' && model.failedNode().icon === 'warning',
  '找不到入口 / 查询失败都有提示行'
);

// --- 10. 降噪：折叠「纯转发 / 小函数」之后，那些名字怎么给人看到 ---
// 折叠**不做成子节点**：被折叠的多半本来就挂在这一步下面（对 getter 来说，
// 最近的保留祖先几乎就是它的调用者），做成子节点等于原地不动、白多一层缩进 ——
// 那样折叠就完全失去意义了。所以它只出现在 tooltip 与视图顶部那行里。
const mainStep = result.steps[0];
check(
  model.foldedNames(mainStep).join() === 'setVerbose',
  `被折叠的名字能取出来：${model.foldedNames(mainStep).join('、')}`
);
check(
  Array.isArray(model.foldedNames(result.steps[2])) && model.foldedNames(result.steps[2]).length === 0,
  '没被折叠的步骤返回空数组（而不是 undefined，省得调用方到处判空）'
);
const mainLines = model.stepDetailLines(mainStep);
check(
  mainLines.some((t) => t.includes('setVerbose')) && mainLines.some((t) => t.includes('6')),
  `tooltip 里既有被折叠的名字、也有函数体大小：${mainLines.join(' / ')}`
);
check(
  model.stepDetailLines(result.steps[2]).length === 0,
  '既没折叠、也拿不到函数体时 tooltip 不加多余行'
);
const trimmedText = model.trimmedLine(result);
check(
  typeof trimmedText === 'string' && trimmedText.includes('1'),
  `视图顶部报出折叠了几个步骤：${trimmedText}`
);
check(
  model.trimmedLine({ ...result, skippedCount: 0 }) === undefined,
  '一个都没折叠时不写「已折叠 0 个」（那一行只占地方）'
);
check(
  model
    .treeChildren(tree, { kind: 'step', step: mainStep, expandable: true }, noOverrides)
    .every((n) => n.kind !== 'step' || n.step.name !== 'setVerbose'),
  '被折叠的步骤不会作为子节点冒出来（否则等于原地不动、白多一层缩进）'
);

// --- 11. 层视图：大项目下先给摘要，再逐层展开（层内分页）---
// 层 = BFS 距离。调用树回答「谁调了谁」，层视图回答「第几跳、这一跳有多少东西」——
// 因为真实项目第 3 层就可能扇出上百个函数，一口气铺开只是又一面墙。
const wideSteps = [step(1, 0, 'main', 'src/main.cpp', 6, { depth: 0, newFile: true })];
for (let i = 0; i < 3; i++) {
  wideSteps.push(
    step(2 + i, 1, `mid${i}`, 'src/app/mid.cpp', 10 + i, { depth: 1, newFile: i === 0 })
  );
}
// 第 3 层故意超过一页（20 个），其中第 3 个带候选（层视图里也要能展开出候选）
for (let i = 0; i < 20; i++) {
  const extra =
    i === 2
      ? {
          ambiguous: true,
          candidateTotal: 1,
          candidates: [candidate('Other::wide', 'src/other.cpp', 5)]
        }
      : {};
  wideSteps.push(
    step(5 + i, 2 + (i % 3), `wide${i}`, `src/core/w${i % 4}.cpp`, 100 + i, { depth: 2, ...extra })
  );
}
const wide = model.buildRouteTree({
  from: 'func:main',
  steps: wideSteps,
  truncated: false,
  frontierNodes: 0,
  frontierFiles: 0,
  maxReachedDepth: 2,
  skippedCount: 0
});

const groups = model.groupByDepth(wide.result);
check(groups.length === 3, `层视图：分出 3 层（实际 ${groups.length}）`);
check(
  groups.map((g) => g.steps.length).join('/') === '1/3/20',
  `每层步骤数 = ${groups.map((g) => g.steps.length).join('/')}`
);
check(
  groups.reduce((n, g) => n + g.steps.length, 0) === wideSteps.length &&
    new Set(groups.flatMap((g) => g.steps.map((s) => s.order))).size === wideSteps.length,
  '每个步骤恰好落在一层里（不重不漏）'
);
check(groups[0].layer === 1 && groups[0].steps[0].name === 'main', '第 1 层就是起点本身');
check(
  groups.every((g, i) => i === 0 || g.layer === groups[i - 1].layer + 1),
  '层号从 1 开始且连续（第 N 层 = 从起点数 N−1 跳）'
);
check(
  groups[2].files === 4 && groups[2].risky === 1,
  `每层都说清规模与风险：第 3 层 ${groups[2].files} 个文件 / ${groups[2].risky} 个带同名定义`
);

const layerRoot = model.layerChildren(wide, undefined, noOverrides);
check(
  layerRoot.filter((n) => n.kind === 'layer').length === 3 && layerRoot.at(-1).kind === 'tail',
  '层视图根层 = 3 个层分组 + 尾行'
);
const smallLayer = layerRoot[1];
const bigLayer = layerRoot[2];
check(
  smallLayer.defaultExpanded === true && bigLayer.defaultExpanded === false,
  '一页能看完的层默认展开，会被分页的层默认收起（收起后就是一行摘要）'
);
check(
  bigLayer.text.includes('第 3 层') && bigLayer.text.includes('20') && bigLayer.text.includes('4'),
  `大层的摘要行本身就说清了规模：${bigLayer.text}`
);

const firstPage = model.layerChildren(wide, bigLayer, noOverrides);
const pageSteps = firstPage.filter((n) => n.kind === 'step');
check(
  pageSteps.length === model.LAYER_PAGE_SIZE,
  `层内先给一页：${pageSteps.length} 步（pageSize=${model.LAYER_PAGE_SIZE}）`
);
const moreNode = firstPage.at(-1);
check(
  moreNode.kind === 'more' &&
    moreNode.hidden === 20 - model.LAYER_PAGE_SIZE &&
    moreNode.layer === 3,
  `一页之后跟一行「${moreNode.text}」—— 点它展开下一页（带着层号）`
);
check(
  pageSteps.every((n, i) => i === 0 || n.step.order > pageSteps[i - 1].step.order) &&
    pageSteps[0].step.order === 5,
  '层内仍按阅读顺序（step.order）排，不是按名字或文件'
);
check(
  pageSteps.every((n) => n.expandable === n.step.ambiguous),
  '层视图里步骤只展开候选（子步骤已经在下一层里，再嵌一次就是重复）'
);
const riskyInLayer = pageSteps.find((n) => n.step.ambiguous);
check(
  !!riskyInLayer &&
    model.layerChildren(wide, riskyInLayer, noOverrides).some((n) => n.kind === 'candidates'),
  '「有候选必须可展开」在层视图里同样成立（候选是纠偏的唯一入口）'
);

const secondPage = model.layerChildren(wide, bigLayer, noOverrides, { shown: new Map([[3, 40]]) });
check(
  secondPage.filter((n) => n.kind === 'step').length === 20 &&
    secondPage.every((n) => n.kind !== 'more'),
  '点过「还有 N 个」之后这一层全部列出，分页行消失'
);

const childStep = wide.result.steps.find((s) => s.order === 5);
const childLines = model.stepDetailLines(childStep, model.parentOf(wide.result, childStep));
check(
  childLines.some((t) => t.includes('调起')),
  `层视图里靠这一行说明「它从哪来」：${childLines.join(' / ')}`
);
check(
  model.parentOf(wide.result, wide.result.steps[0]) === undefined,
  '起点没有父步骤（不会凭空写一行「由 #0 调起」）'
);

// --- 12. 库项目：起点候选列表（没有 main 时列出来，而不是只丢一句「找不到入口」）---
// 引擎只给判据，选哪个由读代码的人定 —— 所以每一行都得说清「为什么推荐它」。
const entries = {
  candidates: [
    {
      id: 'func:libdemo::mean',
      name: 'mean',
      kind: 'function',
      file: 'src/math.cpp',
      line: 16,
      column: 1,
      detail: 'double mean(const int*, int)',
      mainLike: false,
      publicApi: true,
      apiHeader: 'include/libdemo/math.h',
      apiLine: 10,
      callers: 0,
      callees: 1
    },
    {
      id: 'func:libdemo::add',
      name: 'add',
      kind: 'function',
      file: 'src/math.cpp',
      line: 11,
      column: 1,
      detail: 'int add(int, int)',
      mainLike: false,
      publicApi: true,
      apiHeader: 'include/libdemo/math.h',
      apiLine: 7,
      callers: 1,
      callees: 1
    }
  ],
  total: 2,
  hasMain: false
};
const entryRows = model.entryCandidateNodes(entries);
check(
  entryRows.length === 3 && entryRows[0].kind === 'info' && entryRows[1].kind === 'info',
  `起点候选 = 1 行说明 + ${entries.candidates.length} 行候选（实际 ${entryRows.length} 行）`
);
const noMainRow = entryRows[0];
check(/main/.test(noMainRow.text), `说明行直说是库，不绕弯：${noMainRow.text}`);
const firstEntry = entryRows[1];
check(
  firstEntry.description === 'src/math.cpp:16',
  '候选行带 file:line（要能看见它定义在哪，而不是只能看见名字）'
);
check(
  firstEntry.command.command === 'depscan.pickRouteCandidate' &&
    firstEntry.command.arguments[0].parentId === '',
  '点候选 = 换起点（parentId 为空，与 CandidateArgs 的约定一致）'
);
check(
  firstEntry.command.arguments[0].nodeId === 'func:libdemo::mean' &&
    firstEntry.command.arguments[0].reset === false,
  'nodeId 就是候选自己的 id（reset=false，不是「撤回纠偏」）'
);
check(
  /公开接口/.test(firstEntry.tooltip) && /include\/libdemo\/math\.h/.test(firstEntry.tooltip),
  `tooltip 说清「为什么推荐它」：${firstEntry.tooltip.split('\n').join(' / ')}`
);
check(/没有人调用/.test(firstEntry.tooltip), 'tooltip 带上判据「项目里没人调用它」');
check(
  model.entryCandidateNodes({ candidates: [], total: 0, hasMain: false }).length === 0,
  '一个候选都没有时返回空数组（调用方退回「找不到入口」提示）'
);
check(
  model.entryCandidateNodes({ ...entries, hasMain: true })[0].text.includes('起点候选'),
  '有 main 时文案换成「起点候选」（不再说「这是个库」）'
);

// --- 13. 公开接口：步骤换成「接口」图标，tooltip 里写明声明在哪 ---
// 读库的时候「这一步是不是 API」比「它是什么种类」更需要一眼看见。
const apiStep = step(9, 0, 'add', 'src/math.cpp', 11, {
  apiHeader: 'include/libdemo/math.h',
  apiLine: 7
});
const apiTree = model.buildRouteTree({
  from: 'func:libdemo::add',
  steps: [apiStep],
  truncated: false,
  frontierNodes: 0,
  frontierFiles: 0,
  maxReachedDepth: 0,
  skippedCount: 0
});
const apiRow = model.treeChildren(apiTree, undefined, noOverrides)[0];
check(apiRow.icon === 'symbol-interface', `公开接口步骤换成接口图标（${apiRow.icon}）`);
const apiLines = model.stepDetailLines(apiStep);
check(
  apiLines.some((t) => t.includes('公开接口') && t.includes('include/libdemo/math.h:7')),
  `tooltip 写出声明在哪：${apiLines.join(' / ')}`
);
check(
  model.stepDetailLines(result.steps[0]).every((t) => !t.includes('公开接口')),
  '不是公开接口的步骤不会多写一行（头部里不该出现空话）'
);
const apiLayerNode = model.layerChildren(apiTree, undefined, noOverrides)[0];
check(
  model.layerChildren(apiTree, apiLayerNode, noOverrides)[0].icon === 'symbol-interface',
  '层视图里同样换成接口图标（两个视图不该各说各话）'
);

// --- 14. 副标题：当前是什么策略 ---
// 四个开关都是**无状态图标按钮**：点完只看到列表变了，看不出现在是 bfs 还是 dfs、
// 是函数级还是文件级 —— 所以副标题必须把当前状态写出来。
const baseMode = { strategy: 'bfs', groupByFile: false, skipTrivial: false, byLayer: false };
check(
  model.routeModeLabel(baseMode) === '广度优先 · 函数级',
  `默认状态就把策略与粒度写清楚：${model.routeModeLabel(baseMode)}`
);
check(
  model.routeModeLabel({ ...baseMode, strategy: 'dfs', groupByFile: true }) === '深度优先 · 文件级',
  '切了策略与粒度后跟着变（不是固定文案）'
);
const allOn = { strategy: 'bfs', groupByFile: false, skipTrivial: true, byLayer: true };
check(
  model.routeModeLabel(allOn) === '广度优先 · 函数级 · 已降噪 · 层视图',
  `开关只在开启时出现，顺序固定：${model.routeModeLabel(allOn)}`
);

rmSync(workDir, { recursive: true, force: true });

if (failures.length) {
  console.error(`\n[test-route-tree] 失败 ${failures.length} 项`);
  for (const f of failures) console.error(`  - ${f}`);
  process.exit(1);
}
console.log('\n[test-route-tree] 全部通过');
