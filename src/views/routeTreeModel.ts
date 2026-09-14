// 阅读路线视图的**纯**树模型：不 import vscode，可以在 Node 里直接断言。
//
// 为什么单独抽出来：TreeView 的真实渲染没法在无 UI 环境下断言 ——
// 「点开一步，下面应该出现什么」只能靠肉眼看，而肉眼看不出
// 「有候选的步骤忘了可展开」这种错（写这版时我确实先犯过一次，
// 表现是候选那一行根本点不出来）。把「结构」抽成纯函数之后，这部分就进得了 CI。
import type { RouteCandidate, RouteResult, RouteStep } from '../engine/protocol';
import { s } from '../i18n';

/** 候选条目点击时传给 `depscan.pickRouteCandidate` 的参数 */
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
      icon?: string;
      command?: { command: string; title: string };
      tooltip?: string;
    }
  | { kind: 'step'; step: RouteStep; expandable: boolean }
  | { kind: 'candidates'; step: RouteStep; text: string; tooltip: string }
  | { kind: 'candidate'; step: RouteStep; candidate: RouteCandidate; isCurrent: boolean; args: CandidateArgs }
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
    command: { command: 'depscan.indexWorkspace', title: s().actions.reindex }
  };
}

export function failedNode(): RouteTreeNode {
  return { kind: 'info', text: s().route.failed, icon: 'warning' };
}

export function noEntryNode(): RouteTreeNode {
  return { kind: 'info', text: s().route.noEntry, icon: 'info' };
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
  return { kind: 'step', step, expandable: hasChildren || step.ambiguous };
}

function stepChildren(tree: RouteTree, step: RouteStep): RouteTreeNode[] {
  const out: RouteTreeNode[] = (tree.childrenByParent.get(step.order) ?? []).map((child) =>
    stepNode(tree, child)
  );
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
