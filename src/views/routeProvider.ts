import * as vscode from 'vscode';

import type { EntriesResult, RouteOptions, RouteResult } from '../engine/protocol';
import type { NodeKind } from '../graph/model';
import { s } from '../i18n';
import type { IndexService } from '../index/indexer';
import {
  buildRouteTree,
  entryCandidateNodes,
  failedNode,
  LAYER_PAGE_SIZE,
  layerChildren,
  needIndexNode,
  noEntryNode,
  overrideKey,
  parentOf,
  routeModeLabel,
  startLabel,
  stepDetailLines,
  treeChildren,
  trimmedLine,
  type RouteTree,
  type RouteTreeNode
} from './routeTreeModel';

/** 树模型节点 → vscode.TreeItem；结构本身在 routeTreeModel.ts（纯函数，可离线断言） */
type RouteNode = RouteTreeNode;

/**
 * 侧边栏「阅读路线」视图。
 *
 * 为什么是 TreeView 而不是再开一个画布：
 * 这个功能的核心是**顺序**（先读什么、再读什么）。TreeView 天然给了
 * 「有序 + 可缩进 + 键盘上下走 + 点一下跳源码」这四件事，
 * 而力导向图恰恰会把顺序揉乱 —— 那是给「关系」用的，不是给「顺序」用的。
 * 泳道图（每个文件一条泳道）留给后续版本，先确认路线本身读起来合理。
 *
 * 两个可撤销的手工干预：
 *  - 起点：默认 main，也可以从编辑器光标处取（库项目 / 想在项目中间起头时用）
 *  - 候选：同名定义之间的消解可能选错，展开「候选」直接换成另一个
 */
export class RouteTreeProvider implements vscode.TreeDataProvider<RouteNode>, vscode.Disposable {
  private readonly emitter = new vscode.EventEmitter<RouteNode | undefined | void>();
  readonly onDidChangeTreeData = this.emitter.event;

  private tree: RouteTree | undefined;
  private lastOptions: RouteOptions | undefined;
  private loading = false;
  private stale = true;
  private byFile = false;
  private strategy: 'bfs' | 'dfs' = 'bfs';
  /**
   * 降噪：折叠「纯转发 / 小函数」。
   * 引擎默认关（RPC 原样给出全部步骤），插件默认**开** —— 阅读清单里
   * 一堆 getter 只会把真正要读的那几步冲淡；想全看时点标题栏的按钮即可。
   */
  private skipTrivial = true;
  /** 层视图：先给「第 N 层」摘要，再逐层展开 */
  private byLayer = false;
  /**
   * 层号 → 这一层已经展开到多少个步骤。
   * 分页只是**看法**，不该重新问一遍引擎，所以点「还有 N 个」只重渲染：
   * 引擎那边 `maxSteps` 得重新遍历，而这里要的是「同一份路线先少看一点」。
   */
  private readonly shownByLayer = new Map<number, number>();
  /** 起点候选（库项目用）：跟着图一起作废，避免拿到上一份索引的候选 */
  private entriesCache: EntriesResult | undefined;
  private view: vscode.TreeView<RouteNode> | undefined;
  /** 手工指定的起点节点 id；undefined = 自动找入口 */
  private from: string | undefined;
  /**
   * 人工纠偏：`"<父节点 id>|<简单名>"` → 改用的节点 id。
   * 用节点 id 而不是步号做 key —— 步号会随纠偏本身变化，节点 id 不会。
   * 与引擎侧的约定必须一字不差，见 engine/src/route.cpp 的 applyOverrides。
   */
  private readonly overrides = new Map<string, string>();

  /** 用 TreeView.message 显示起点与精度提示 —— 不然这些文字会占掉节点行 */
  attachView(view: vscode.TreeView<RouteNode>): void {
    this.view = view;
    this.updateMessage();
  }

  private updateMessage(): void {
    if (!this.view) return;
    // 标题从**运行期文案**来：清单里的标题只跟 VS Code 显示语言走（见 docs/02 §1.2），
    // 而 TreeView.title 能在运行期改 —— 不这样就会出现「界面中文、标题英文」。
    this.view.title = s().views.route;
    // 副标题摆「当前是什么策略」：四个开关都是无状态图标，不写出来根本看不出来
    this.view.description = routeModeLabel({
      strategy: this.strategy,
      groupByFile: this.byFile,
      skipTrivial: this.skipTrivial,
      byLayer: this.byLayer
    });
    this.view.message = this.statusMessage();
  }

  /** 让「起点回到 main」这类按钮只在真的改了起点时才出现 */
  private updateContext(): void {
    void vscode.commands.executeCommand('setContext', 'depscan.routeCustomStart', !!this.from);
  }

  get customStart(): boolean {
    return !!this.from;
  }

  constructor(private readonly indexer: IndexService) {
    // 图变了（重新索引 / 增量更新）→ 路线作废，下次展开时重新生成
    this.indexer.onDidUpdateGraph.event(() => {
      this.invalidate();
      this.emitter.fire();
    });
    this.indexer.onDidChangeStatus.event((status) => {
      if (status.state === 'ready') this.emitter.fire();
    });
  }

  dispose(): void {
    this.emitter.dispose();
  }

  /** 设置起点（undefined = 回到自动识别 main） */
  setStart(nodeId: string | undefined): void {
    this.from = nodeId;
    this.refresh();
  }

  /**
   * 纠偏：把「父节点下叫 name 的那个子节点」换成 nodeId。
   * nodeId === undefined 表示撤回这条纠偏。
   */
  correct(parentId: string, name: string, nodeId: string | undefined): void {
    const key = overrideKey(parentId, name);
    if (nodeId) this.overrides.set(key, nodeId);
    else this.overrides.delete(key);
    this.refresh();
  }

  /** 重新生成并刷新 */
  refresh(): void {
    this.invalidate();
    this.updateContext();
    this.updateMessage();
    this.emitter.fire();
  }

  /** 只刷新渲染（语言切换等） */
  repaint(): void {
    this.updateMessage();
    this.emitter.fire();
  }

  /**
   * 只标记作废，**不**同步清空 result。
   * 清空会让「刷新」瞬间闪一下空列表（TreeView 会先拿到 []），
   * 而且如果此时正好在加载，getChildren 会因 loading 直接返回空。
   */
  private invalidate(): void {
    this.stale = true;
    this.entriesCache = undefined;
  }

  get groupByFile(): boolean {
    return this.byFile;
  }

  async toggleGroupByFile(): Promise<void> {
    this.byFile = !this.byFile;
    this.refresh();
  }

  async toggleStrategy(): Promise<void> {
    this.strategy = this.strategy === 'bfs' ? 'dfs' : 'bfs';
    this.refresh();
  }

  get hideTrivial(): boolean {
    return this.skipTrivial;
  }

  async toggleSkipTrivial(): Promise<void> {
    this.skipTrivial = !this.skipTrivial;
    this.refresh();
  }

  get byLayerMode(): boolean {
    return this.byLayer;
  }

  async toggleByLayer(): Promise<void> {
    this.byLayer = !this.byLayer;
    this.shownByLayer.clear();
    this.refresh();
  }

  /** 层视图里点「还有 N 个」：这一层再多展开一页 */
  expandLayer(layer: number): void {
    this.shownByLayer.set(layer, (this.shownByLayer.get(layer) ?? LAYER_PAGE_SIZE) + LAYER_PAGE_SIZE);
    this.emitter.fire();
  }

  /** 起点 + 精度提示显示在视图顶部（TreeView.message），不占用节点行 */
  statusMessage(): string | undefined {
    if (!this.tree) return undefined;
    const result = this.tree.result;
    const name = startLabel(result.from);
    const first = result.steps[0];
    const at = first?.file ? `${first.file}:${first.line}` : '';
    let from: string;
    if (this.from) from = at ? s().route.fromPicked(name, at) : s().route.fromShort(name);
    else from = at ? s().route.from(name, first.file) : s().route.fromShort(name);
    const lines = [from, s().route.precisionHint];
    const trimmed = trimmedLine(result);
    if (trimmed) lines.push(trimmed);
    if (this.tree.riskyCount > 0) lines.push(s().route.candidateHint(this.tree.riskyCount));
    return lines.join('\n');
  }

  getTreeItem(element: RouteNode): vscode.TreeItem {
    if (element.kind === 'info') {
      const item = new vscode.TreeItem(element.text, vscode.TreeItemCollapsibleState.None);
      if (element.icon) item.iconPath = new vscode.ThemeIcon(element.icon);
      if (element.command) item.command = element.command;
      return item;
    }
    if (element.kind === 'tail') {
      const item = new vscode.TreeItem(element.text, vscode.TreeItemCollapsibleState.None);
      item.iconPath = new vscode.ThemeIcon(element.icon);
      item.tooltip = element.text;
      return item;
    }
    if (element.kind === 'candidates') {
      const item = new vscode.TreeItem(element.text, vscode.TreeItemCollapsibleState.Collapsed);
      item.iconPath = new vscode.ThemeIcon('list-selection');
      item.tooltip = element.tooltip;
      item.contextValue = 'depscan.routeCandidates';
      return item;
    }
    if (element.kind === 'candidate') {
      const { candidate, isCurrent, args } = element;
      const label = isCurrent ? `${candidate.id}（${s().route.current}）` : candidate.id;
      const item = new vscode.TreeItem(label, vscode.TreeItemCollapsibleState.None);
      item.description = `${candidate.file}:${candidate.line}`;
      item.iconPath = isCurrent
        ? new vscode.ThemeIcon('check')
        : new vscode.ThemeIcon('circle-small-filled');
      item.tooltip = [candidate.id, `${candidate.file}:${candidate.line}`, candidate.detail]
        .filter(Boolean)
        .join('\n');
      // 「当前」那一项点了就是撤回纠偏（args.reset）
      item.command = {
        command: 'depscan.pickRouteCandidate',
        title: isCurrent
          ? s().route.resetCandidate
          : s().route.useCandidate(candidate.file, candidate.line),
        arguments: [args]
      };
      return item;
    }

    if (element.kind === 'layer') {
      const item = new vscode.TreeItem(
        element.text,
        element.defaultExpanded
          ? vscode.TreeItemCollapsibleState.Expanded
          : vscode.TreeItemCollapsibleState.Collapsed
      );
      item.iconPath = new vscode.ThemeIcon('layers');
      item.tooltip = element.tooltip;
      item.contextValue = 'depscan.routeLayer';
      return item;
    }
    if (element.kind === 'more') {
      const item = new vscode.TreeItem(element.text, vscode.TreeItemCollapsibleState.None);
      item.iconPath = new vscode.ThemeIcon('ellipsis');
      item.tooltip = element.tooltip;
      item.command = {
        command: 'depscan.expandRouteLayer',
        title: element.text,
        arguments: [element.layer]
      };
      return item;
    }

    const step = element.step;
    // 步号放最左边 —— 这个视图里「第几步」比「叫什么」更重要
    const label = `${s().route.step(step.order)} ${step.name}`;
    const item = new vscode.TreeItem(
      label,
      // 「可展开」由模型算（含「有候选就必须展开」这条）—— 写在这儿容易漏
      element.expandable ? vscode.TreeItemCollapsibleState.Expanded : vscode.TreeItemCollapsibleState.None
    );
    item.description = `${step.file}:${step.line}`;

    const tooltip: string[] = [
      `${s().route.step(step.order)} ${step.id}`,
      `${step.file}:${step.line}`,
      `${s().kinds[step.kind as NodeKind] ?? step.kind}`
    ];
    if (step.detail) tooltip.push(step.detail);
    tooltip.push(...stepDetailLines(step, this.tree ? parentOf(this.tree.result, step) : undefined));
    if (step.ambiguous) tooltip.push(`⚠ ${s().route.ambiguous}`);
    if (step.external) tooltip.push(s().route.external);
    if (step.newFile) tooltip.push(s().route.newFile);
    item.tooltip = tooltip.join('\n');

    if (step.ambiguous) {
      item.iconPath = new vscode.ThemeIcon('warning', new vscode.ThemeColor('charts.yellow'));
    } else if (step.external) {
      item.iconPath = new vscode.ThemeIcon('globe');
    } else if (element.icon) {
      // 公开接口：图标由模型给（读库时「是不是 API」比「是不是函数」更需要一眼看见）
      item.iconPath = new vscode.ThemeIcon(element.icon);
    } else {
      item.iconPath = new vscode.ThemeIcon(kindIcon(step.kind));
    }

    if (step.file) {
      item.command = {
        command: 'depscan.openNode',
        title: 'open',
        arguments: [step.file, step.line, step.column]
      };
    }
    return item;
  }

  async getChildren(element?: RouteNode): Promise<RouteNode[]> {
    if (!element) {
      if (!this.indexer.currentStatus.stats) return [needIndexNode()];
      if (this.stale && !this.loading) await this.load();
      if (!this.tree) {
        // 正在加载：不要返回 [] 去覆盖上一次的内容
        return this.loading ? [] : [failedNode()];
      }
      if (this.tree.result.steps.length === 0) {
        // 库项目（没有 main）：把「从哪读起」的候选列出来，而不是只丢一句「找不到入口」
        const entries = await this.loadEntries();
        const nodes = entries ? entryCandidateNodes(entries) : [];
        return nodes.length > 0 ? nodes : [noEntryNode()];
      }
      return this.childrenOf(undefined);
    }
    return this.childrenOf(element);
  }

  /** 调用树视图与层视图只差「怎么取子节点」，其余（加载、状态行、纠偏）完全共用 */
  private childrenOf(element: RouteNode | undefined): RouteNode[] {
    if (!this.tree) return [];
    return this.byLayer
      ? layerChildren(this.tree, element, this.overrides, { shown: this.shownByLayer })
      : treeChildren(this.tree, element, this.overrides);
  }

  /** 起点候选只问一次（它跟着索引走，图一变就作废） */
  private async loadEntries(): Promise<EntriesResult | undefined> {
    if (!this.entriesCache) this.entriesCache = await this.indexer.entries();
    return this.entriesCache;
  }

  private async load(): Promise<void> {
    this.loading = true;
    try {
      const options: RouteOptions = {
        from: this.from,
        strategy: this.strategy,
        groupByFile: this.byFile,
        skipTrivial: this.skipTrivial,
        maxSteps: 300,
        maxDepth: 6,
        overrides: this.overrides.size ? Object.fromEntries(this.overrides) : undefined
      };
      this.lastOptions = options;
      const result = await this.indexer.route(options);
      this.tree = result ? buildRouteTree(result) : undefined;
    } finally {
      this.loading = false;
      this.stale = false;
      this.updateContext();
      this.updateMessage();
    }
  }

  /**
   * 泳道图要用的快照：确保路线已生成，并连同**当初的查询参数**一起给出。
   *
   * 为什么要带参数：泳道图必须画和侧边栏**同一条**路线（同一个起点、同一批纠偏），
   * 不能自己另算一条 —— 否则两个界面会各说各话：
   * 你在侧边栏把某个候选换掉了，图里却还是原来的顺序。
   */
  async routeSnapshot(): Promise<{ options: RouteOptions; result: RouteResult } | undefined> {
    if (!this.indexer.currentStatus.stats) {
      return undefined;
    }
    if (this.stale && !this.loading) {
      await this.load();
      // 这次加载是命令（泳道图）触发的，不是 TreeView 拉取触发的，
      // 得自己通知一次视图，否则侧边栏会停在旧内容上。
      this.updateContext();
      this.updateMessage();
      this.emitter.fire();
    }
    if (!this.tree || !this.lastOptions) return undefined;
    return { options: this.lastOptions, result: this.tree.result };
  }
}

/** 「候选」条目点击时传给 depscan.pickRouteCandidate 的参数（定义在纯模型里） */
export type { CandidateArgs } from './routeTreeModel';

function kindIcon(kind: NodeKind): string {
  switch (kind) {
    case 'function':
      return 'symbol-method';
    case 'class':
      return 'symbol-class';
    case 'enum':
      return 'symbol-enum';
    case 'variable':
      return 'symbol-variable';
    case 'macro':
      return 'symbol-constant';
    case 'file':
      return 'file-code';
    case 'target':
      return 'package';
    default:
      return 'circle-outline';
  }
}
