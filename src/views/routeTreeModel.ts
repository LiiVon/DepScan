// 阅读路线视图的**纯**树模型：不 import vscode，可以在 Node 里直接断言。
//
// 为什么单独抽出来：TreeView 的真实渲染没法在无 UI 环境下断言 ——
// 「点开一步，下面应该出现什么」只能靠肉眼看，而肉眼看不出
// 「有候选的步骤忘了可展开」这种错（写这版时我确实先犯过一次，
// 表现是候选那一行根本点不出来）。把「结构」抽成纯函数之后，这部分就进得了 CI。
import type { EntryCandidate, EntriesResult, RouteCandidate, RouteResult, RouteStep } from '../engine/protocol';
import { s } from '../i18n';

/** 候选条目点击时传给 `depscaner.pickRouteCandidate` 的参数 */
export interface CandidateArgs {
  /** 父节点 id；空表示这一步是起点（改的是起点本身） */
  parentId: string;
  name: string;
  /** 改用的节点 id；reset 为 true 时忽略 */
  nodeId: string;
  /** true = 撤回纠偏，回到引擎按名字消解的结果 */
  reset: boolean;
}

export type RouteTreeNode =
  | {
      kind: 'info';
      text: string;
      /** 右侧那列（"info" 行大多是提示，但起点候选得显示 file:line） */
      description?: string;
      icon?: string;
      command?: { command: string; title: string; arguments?: unknown[] };
      tooltip?: string;
    }
  | { kind: 'step'; step: RouteStep; expandable: boolean; /** 公开接口换成接口图标（由模型决定，便于断言） */ icon?: string }
  | { kind: 'candidates'; step: RouteStep; text: string; tooltip: string }
  | { kind: 'candidate'; step: RouteStep; candidate: RouteCandidate; isCurrent: boolean; args: CandidateArgs }
  /** 层视图里的「第 N 层」分组；默认展开与否由这一层的步骤数决定 */
  | { kind: 'layer'; layer: number; text: string; tooltip: string; defaultExpanded: boolean }
  /** 层视图里的分页行：这一层还有几个没列出来 */
  | { kind: 'more'; layer: number; text: string; tooltip: string; hidden: number }
  | { kind: 'tail'; text: string; icon: string };

export interface RouteTree {
  result: RouteResult;
  /** parent order → 子步骤（保持引擎给出的先后顺序） */
  childrenByParent: Map<number, RouteStep[]>;
  /** 根步骤（parent === 0）；正常只有一个，折叠后也必须还是一个 */
  roots: RouteStep[];
  /** 有同名定义的步骤数 —— 显示在视图顶部 */
  riskyCount: number;
}

/**
 * 纠偏 key：`<父节点 id>|<简单名>`。
 *
 * **分隔符是与引擎的约定**，见 engine/src/route.cpp 的 applyOverrides
 * （那边是 `pid + "|" + name`）。改了这里必须同步改那边，否则纠偏会静默失效
 * （点了候选、路线一点变化都没有）。
 */
export function overrideKey(parentId: string, name: string): string {
  return `${parentId}|${name}`;
}

/**
 * 把节点 id 变成给人看的起点名：`func:demo::Engine::run` → `demo::Engine::run`。
 * 侧边栏顶部提示与泳道图标题共用它 —— 两边显示同一个起点，不该各自实现一次。
 */
export function startLabel(from: string): string {
  return from.replace(/^func:/, '').replace(/^ext:[^:]+:/, '');
}

export function buildRouteTree(result: RouteResult): RouteTree {
  const childrenByParent = new Map<number, RouteStep[]>();
  for (const step of result.steps) {
    if (step.parent === 0) continue;
    const list = childrenByParent.get(step.parent);
    if (list) list.push(step);
    else childrenByParent.set(step.parent, [step]);
  }
  return {
    result,
    childrenByParent,
    roots: result.steps.filter((step) => step.parent === 0),
    riskyCount: result.steps.filter((step) => step.ambiguous).length
  };
}

/** 还没有索引时的提示（带一次点击去重建索引） */
export function needIndexNode(): RouteTreeNode {
  return {
    kind: 'info',
    text: s().route.needIndex,
    icon: 'info',
    command: { command: 'depscaner.indexWorkspace', title: s().actions.reindex }
  };
}

export function failedNode(): RouteTreeNode {
  return { kind: 'info', text: s().route.failed, icon: 'warning' };
}

export function noEntryNode(): RouteTreeNode {
  return { kind: 'info', text: s().route.noEntry, icon: 'info' };
}

/**
 * 没有 main 的库项目：把「从哪读起」的候选列出来。
 *
 * 为什么是列出来而不是替用户挑一个：路线的全部价值就是**顺序**，而顺序由起点决定 ——
 * 挑错了，后面整条都是错的。引擎只给判据（是不是公开面？多少人调用？多少个下游？），
 * 由读代码的人来定。点一行就是「换起点」（parentId 为空 → 命令知道这是起点不是纠偏）。
 *
 * 一条都没有时返回空数组，调用方退回 `noEntryNode()` —— 那时真的没什么可推荐的。
 */
export function entryCandidateNodes(result: EntriesResult): RouteTreeNode[] {
  if (result.candidates.length === 0) return [];
  const total = result.total || result.candidates.length;
  return [
    {
      kind: 'info',
      // 有 main 时（调试出口）不必说「没有 main」
      text: result.hasMain ? s().route.entryCandidates(total) : s().route.noMainHint,
      icon: result.hasMain ? 'library' : 'info',
      tooltip: s().route.entryHint
    },
    ...result.candidates.map(entryCandidateNode)
  ];
}

function entryCandidateNode(c: EntryCandidate): RouteTreeNode {
  const lines = [c.id, `${c.file}:${c.line}`];
  if (c.publicApi) lines.push(s().route.publicApiLine(c.apiHeader, c.apiLine));
  lines.push(s().route.entryCallers(c.callers));
  lines.push(s().route.entryCallees(c.callees));
  return {
    kind: 'info',
    text: c.name,
    description: `${c.file}:${c.line}`,
    icon: c.mainLike ? 'play' : c.publicApi ? 'symbol-interface' : 'circle-outline',
    tooltip: lines.join('\n'),
    command: {
      command: 'depscaner.pickRouteCandidate',
      title: s().route.startFromHere,
      // parentId 为空 = 这是**起点**（见 CandidateArgs 的约定），不是纠偏
      arguments: [{ parentId: '', name: c.name, nodeId: c.id, reset: false }]
    }
  };
}

/** 尾行：完整 / 被步数或深度上限截断 */
export function tailNode(result: RouteResult): RouteTreeNode {
  if (result.truncated) {
    return {
      kind: 'tail',
      icon: 'ellipsis',
      text: s().route.truncated(result.frontierNodes, result.frontierFiles)
    };
  }
  return { kind: 'tail', icon: 'check', text: s().route.complete };
}

/**
 * 降噪折叠掉的琐碎步骤名（纯转发 / 小函数）。
 *
 * 折叠**不是静默删除**：引擎把折叠掉的名字挂到最近的那个保留步骤上
 * （`RouteStep.skipped`），这里只负责把它变成给人看的一行。
 *
 * 为什么不做成子节点：被折叠的多数本来就挂在这一步下面（对 getter 来说，
 * 最近的保留祖先几乎就是它的调用者），做成子节点等于原地不动、白多一层缩进 ——
 * 那样折叠就完全失去意义了。所以它只出现在 tooltip 与视图顶部那行里。
 */
export function foldedNames(step: RouteStep): string[] {
  return step.skipped ?? [];
}

/** 步骤 tooltip 的附加行：函数体大小、被折叠掉的名字、由谁调起、是不是公开接口 */
export function stepDetailLines(step: RouteStep, parent?: RouteStep): string[] {
  const out: string[] = [];
  if (step.bodyLines > 0) out.push(s().route.bodyLines(step.bodyLines));
  if (step.apiHeader) out.push(s().route.publicApiLine(step.apiHeader, step.apiLine ?? 0));
  const folded = foldedNames(step);
  if (folded.length > 0) out.push(s().route.skippedNames(folded));
  // 层视图里没有缩进，这一行就是「它从哪来」——树视图里顺带也给（便于跳到调用方）
  if (parent) out.push(s().route.calledFrom(parent.order, parent.name));
  return out;
}

/** 这一步的父步骤；起点没有父步骤 → undefined */
export function parentOf(result: RouteResult, step: RouteStep): RouteStep | undefined {
  return step.parent === 0 ? undefined : result.steps.find((x) => x.order === step.parent);
}

/**
 * 视图顶部那一行「已折叠 N 个琐碎步骤」；没折叠时返回 undefined
 * （没折叠还写一行「已折叠 0 个」只会占地方）。
 */
export function trimmedLine(result: RouteResult): string | undefined {
  return result.skippedCount > 0 ? s().route.trimmed(result.skippedCount) : undefined;
}

/**
 * 取某个节点的子节点。`element` 为 undefined 时返回根。
 *
 * 三条容易写错的规则都在这里，且都有断言兜着：
 *  1. 有候选的步骤**必须可展开**，否则「候选」那一行永远露不出来；
 *  2. 只有真存在同名定义时才挂候选分组 —— 处处都挂会把信号淹掉；
 *  3. 候选列表里「当前用的那一个」由前端补出来（引擎给的候选不含自己），
 *     而且它必须可点：点它就是撤回纠偏，否则用户遇到「选错了回不去」。
 */
export function treeChildren(
  tree: RouteTree,
  element: RouteTreeNode | undefined,
  overrides: ReadonlyMap<string, string>
): RouteTreeNode[] {
  if (!element) return [...tree.roots.map((step) => stepNode(tree, step)), tailNode(tree.result)];
  if (element.kind === 'step') return stepChildren(tree, element.step);
  if (element.kind === 'candidates') return candidateChildren(tree, element.step, overrides);
  return [];
}

function stepNode(tree: RouteTree, step: RouteStep): RouteTreeNode {
  const hasChildren = (tree.childrenByParent.get(step.order) ?? []).length > 0;
  return {
    kind: 'step',
    step,
    expandable: hasChildren || step.ambiguous,
    icon: publicApiIcon(step)
  };
}

/** 公开接口在列表里换成「接口」图标：读库时「这一步是不是 API」比它是什么种类更重要 */
function publicApiIcon(step: RouteStep): string | undefined {
  return step.apiHeader ? 'symbol-interface' : undefined;
}

function stepChildren(tree: RouteTree, step: RouteStep, onlyCandidates = false): RouteTreeNode[] {
  const out: RouteTreeNode[] = onlyCandidates
    ? []
    : (tree.childrenByParent.get(step.order) ?? []).map((child) => stepNode(tree, child));
  if (step.ambiguous) {
    out.push({
      kind: 'candidates',
      step,
      text: s().route.candidates(step.candidateTotal),
      tooltip: s().route.ambiguous
    });
  }
  return out;
}

function candidateChildren(
  tree: RouteTree,
  step: RouteStep,
  overrides: ReadonlyMap<string, string>
): RouteTreeNode[] {
  const parentId = parentIdOf(tree, step);
  const corrected = overrides.has(overrideKey(parentId, step.name));
  const out: RouteTreeNode[] = [
    {
      kind: 'candidate',
      step,
      isCurrent: true,
      candidate: {
        id: step.id,
        name: step.name,
        file: step.file,
        line: step.line,
        column: step.column,
        declaration: false,
        detail: corrected ? s().route.resetCandidate : s().route.current
      },
      args: { parentId, name: step.name, nodeId: '', reset: true }
    }
  ];
  for (const candidate of step.candidates ?? []) {
    out.push({
      kind: 'candidate',
      step,
      candidate,
      isCurrent: false,
      args: { parentId, name: step.name, nodeId: candidate.id, reset: false }
    });
  }
  return out;
}

/** 这一步的父节点 id；根步骤（parent === 0）没有父节点 → 空串 */
function parentIdOf(tree: RouteTree, step: RouteStep): string {
  if (step.parent === 0) return '';
  return tree.result.steps.find((x) => x.order === step.parent)?.id ?? '';
}

// ── 层视图：大项目下先给摘要，再一层层展开 ───────────────────────────
//
// 为什么要有第二种看法：调用树回答「谁调了谁」，但真实项目第 3 层就可能扇出上百个函数 ——
// 一口气铺开就成了另一面墙。按层分组时你先看到的是摘要（第 1 层 1 个、第 2 层 4 个、
// 第 3 层 87 个……），想读哪层就展开哪层（层内按阅读顺序排），一层里太多就先给一页。

/** 层视图里一层先显示多少个步骤（只在层视图用；调用树视图不受影响） */
export const LAYER_PAGE_SIZE = 15;

export interface LayerGroup {
  /** 层号（1-based）：1 = 起点本身，N = 从起点数 N−1 次调用能到的函数 */
  layer: number;
  /** 这一层的步骤，仍按阅读顺序（step.order）排 */
  steps: RouteStep[];
  /** 这一层涉及多少个文件 */
  files: number;
  /** 这一层里带同名定义的步骤数 */
  risky: number;
}

/**
 * 按层（BFS 距离）分组。
 *
 * 靠的是引擎保证的不变量：非起点步骤的深度一定等于它父步骤的深度 + 1
 * （`scripts/test-rpc.mjs` 里钉着这条）。DFS 策略下深度仍然是「从起点算的跳数」，
 * 所以层视图对两种策略都成立 —— 只是同一层内的顺序会不一样。
 */
export function groupByDepth(result: RouteResult): LayerGroup[] {
  const byDepth = new Map<number, RouteStep[]>();
  for (const step of result.steps) {
    const list = byDepth.get(step.depth);
    if (list) list.push(step);
    else byDepth.set(step.depth, [step]);
  }
  return [...byDepth.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([depth, steps]) => ({
      layer: depth + 1,
      steps: [...steps].sort((a, b) => a.order - b.order),
      files: new Set(steps.map((x) => x.file)).size,
      risky: steps.filter((x) => x.ambiguous).length
    }));
}

export interface LayerViewOptions {
  pageSize?: number;
  /** 层号 → 这一层已经展开到多少个（缺省 = 一页） */
  shown?: ReadonlyMap<number, number>;
}

/**
 * 层视图的子节点。
 *
 * 与调用树视图的差别只有两条：
 *  1. 根层是「第 N 层」分组，不是步骤本身；
 *  2. 一层里步骤分页（超过一页时末尾给一行「还有 N 个」）。
 * 步骤在层视图里**只能展开候选**：它的子步骤已经在下一层里了，再嵌一次是重复。
 */
export function layerChildren(
  tree: RouteTree,
  element: RouteTreeNode | undefined,
  overrides: ReadonlyMap<string, string>,
  options: LayerViewOptions = {}
): RouteTreeNode[] {
  const pageSize = options.pageSize ?? LAYER_PAGE_SIZE;
  if (!element) {
    return [...groupByDepth(tree.result).map((g) => layerNode(g, pageSize)), tailNode(tree.result)];
  }
  if (element.kind === 'layer') {
    const group = groupByDepth(tree.result).find((g) => g.layer === element.layer);
    if (!group) return [];
    const shown = options.shown?.get(element.layer) ?? pageSize;
    const visible = group.steps.slice(0, Math.max(pageSize, shown));
    const out: RouteTreeNode[] = visible.map(layerStepNode);
    const hidden = group.steps.length - visible.length;
    if (hidden > 0) {
      out.push({
        kind: 'more',
        layer: element.layer,
        text: s().route.moreInLayer(hidden),
        tooltip: s().route.moreInLayerHint,
        hidden
      });
    }
    return out;
  }
  if (element.kind === 'step') return stepChildren(tree, element.step, true);
  if (element.kind === 'candidates') return candidateChildren(tree, element.step, overrides);
  return [];
}

/**
 * 「第 N 层」分组行。
 *
 * **只有会被分页的层才默认收起** —— 一页能看完的层收起来只是白多点一下，
 * 而大层默认铺开就是又一面墙。
 */
function layerNode(group: LayerGroup, pageSize: number): RouteTreeNode {
  const tooltip = [s().route.layerLegend];
  if (group.risky > 0) tooltip.push(s().route.layerRisky(group.risky));
  return {
    kind: 'layer',
    layer: group.layer,
    text: s().route.layer(group.layer, group.steps.length, group.files),
    tooltip: tooltip.join('\n'),
    defaultExpanded: group.steps.length <= pageSize
  };
}

/** 层视图里的步骤行：子步骤在下一层，所以只有候选可展开 */
function layerStepNode(step: RouteStep): RouteTreeNode {
  return { kind: 'step', step, expandable: step.ambiguous, icon: publicApiIcon(step) };
}
