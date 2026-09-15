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

const workDir = mkdtempSync(join(tmpdir(), 'depscaner-route-tree-'));
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
  maxReachedDepth: 4
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

rmSync(workDir, { recursive: true, force: true });

if (failures.length) {
  console.error(`\n[test-route-tree] 失败 ${failures.length} 项`);
  for (const f of failures) console.error(`  - ${f}`);
  process.exit(1);
}
console.log('\n[test-route-tree] 全部通过');
