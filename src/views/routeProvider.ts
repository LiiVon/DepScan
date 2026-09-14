import * as vscode from 'vscode';

import type { RouteOptions, RouteResult, RouteStep } from '../engine/protocol';
import type { NodeKind } from '../graph/model';
import { s } from '../i18n';
import type { IndexService } from '../index/indexer';

type RouteNode =
  | { kind: 'info'; text: string; icon?: string; command?: vscode.Command }
  | { kind: 'step'; step: RouteStep }
  | { kind: 'tail'; text: string; icon: string };

/**
 * 侧边栏「阅读路线」视图。
 *
 * 为什么是 TreeView 而不是再开一个画布：
 * 这个功能的核心是**顺序**（先读什么、再读什么）。TreeView 天然给了
 * 「有序 + 可缩进 + 键盘上下走 + 点一下跳源码」这四件事，
 * 而力导向图恰恰会把顺序揉乱 —— 那是给「关系」用的，不是给「顺序」用的。
 * 泳道图（每个文件一条泳道）留给后续版本，先确认路线本身读起来合理。
 */
export class RouteTreeProvider implements vscode.TreeDataProvider<RouteNode>, vscode.Disposable {
  private readonly emitter = new vscode.EventEmitter<RouteNode | undefined | void>();
  readonly onDidChangeTreeData = this.emitter.event;

  private readonly children = new Map<number, RouteStep[]>();
  private result: RouteResult | undefined;
  private loading = false;
  private stale = true;
  private byFile = false;
  private strategy: 'bfs' | 'dfs' = 'bfs';
  private view: vscode.TreeView<RouteNode> | undefined;

  /** 用 TreeView.message 显示起点与精度提示 —— 不然这些文字会占掉节点行 */
  attachView(view: vscode.TreeView<RouteNode>): void {
    this.view = view;
    this.updateMessage();
  }

  private updateMessage(): void {
    if (this.view) this.view.message = this.statusMessage();
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

  /** 重新生成并刷新 */
  refresh(): void {
    this.invalidate();
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

  /** 起点 + 精度提示显示在视图顶部（TreeView.message），不占用节点行 */
  statusMessage(): string | undefined {
    if (!this.result) return undefined;
    const head = this.result.from;
    const name = head.replace(/^func:/, '').replace(/^ext:[^:]+:/, '');
    const file = this.result.steps[0]?.file ?? '';
    const from = file ? s().route.from(name, file) : s().route.fromShort(name);
    return `${from}\n${s().route.precisionHint}`;
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

    const step = element.step;
    // 步号放最左边 —— 这个视图里「第几步」比「叫什么」更重要
    const label = `${s().route.step(step.order)} ${step.name}`;
    const kids = this.children.get(step.order) ?? [];
    const item = new vscode.TreeItem(
      label,
      kids.length > 0 ? vscode.TreeItemCollapsibleState.Expanded : vscode.TreeItemCollapsibleState.None
    );
    item.description = `${step.file}:${step.line}`;

    const tooltip: string[] = [
      `${s().route.step(step.order)} ${step.id}`,
      `${step.file}:${step.line}`,
      `${s().kinds[step.kind as NodeKind] ?? step.kind}`
    ];
    if (step.detail) tooltip.push(step.detail);
    if (step.ambiguous) tooltip.push(`⚠ ${s().route.ambiguous}`);
    if (step.external) tooltip.push(s().route.external);
    if (step.newFile) tooltip.push(s().route.newFile);
    item.tooltip = tooltip.join('\n');

    if (step.ambiguous) {
      item.iconPath = new vscode.ThemeIcon('warning', new vscode.ThemeColor('charts.yellow'));
    } else if (step.external) {
      item.iconPath = new vscode.ThemeIcon('globe');
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
    if (element) {
      if (element.kind !== 'step') return [];
      return (this.children.get(element.step.order) ?? []).map((step) => ({ kind: 'step', step }));
    }

    if (!this.indexer.currentStatus.stats) {
      return [
        {
          kind: 'info',
          text: s().route.needIndex,
          icon: 'info',
          command: { command: 'depscan.indexWorkspace', title: s().actions.reindex }
        }
      ];
    }

    if (this.stale && !this.loading) {
      await this.load();
    }
    if (!this.result) {
      // 正在加载：不要返回 [] 去覆盖上一次的内容
      return this.loading ? [] : [{ kind: 'info', text: s().route.failed, icon: 'warning' }];
    }
    if (this.result.steps.length === 0) {
      return [{ kind: 'info', text: s().route.noEntry, icon: 'info' }];
    }

    const out: RouteNode[] = this.result.steps
      .filter((step) => step.parent === 0)
      .map((step) => ({ kind: 'step', step }) as RouteNode);

    if (this.result.truncated) {
      out.push({
        kind: 'tail',
        icon: 'ellipsis',
        text: s().route.truncated(this.result.frontierNodes, this.result.frontierFiles)
      });
    } else {
      out.push({ kind: 'tail', icon: 'check', text: s().route.complete });
    }
    return out;
  }

  private async load(): Promise<void> {
    this.loading = true;
    try {
      const options: RouteOptions = {
        strategy: this.strategy,
        groupByFile: this.byFile,
        maxSteps: 300,
        maxDepth: 6
      };
      this.result = await this.indexer.route(options);
      this.children.clear();
      if (this.result) {
        // 一次把父子关系建好：getChildren 会被高频调用，不能每次都扫全表
        for (const step of this.result.steps) {
          if (step.parent === 0) continue;
          const list = this.children.get(step.parent);
          if (list) list.push(step);
          else this.children.set(step.parent, [step]);
        }
      }
    } finally {
      this.loading = false;
      this.stale = false;
      this.updateMessage();
    }
  }
}

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
