import * as vscode from 'vscode';

import { readConfig } from '../config';
import { languageLabel, precisionLabel, s, type UiLanguage } from '../i18n';
import type { IndexService } from '../index/indexer';
import type { RouteTreeProvider } from './routeProvider';

export type ActionNode =
  | { kind: 'command'; id: string; label: string; icon: string; description?: string }
  | { kind: 'language' }
  | { kind: 'language-choice'; value: UiLanguage };

/**
 * 侧边栏「操作」视图：把常用命令变成一次点击，避免每次去命令面板。
 * 标签在 getChildren 时动态生成，所以切换语言后立刻生效。
 */
export class ActionsTreeProvider implements vscode.TreeDataProvider<ActionNode>, vscode.Disposable {
  private readonly emitter = new vscode.EventEmitter<ActionNode | undefined | void>();
  readonly onDidChangeTreeData = this.emitter.event;

  private readonly routeRef: RouteTreeProvider | undefined;
  private readonly routeSub: vscode.Disposable | undefined;

  constructor(private readonly indexer: IndexService, route?: RouteTreeProvider) {
    // 索引状态变化时刷新（比如把"取消索引"置灰的时机）
    this.indexer.onDidChangeStatus.event(() => this.emitter.fire());
    // 起点被改过 / 改回来，都会决定「起点回到 main」这一项该不该出现
    this.routeRef = route;
    this.routeSub = route?.onDidChangeTreeData(() => this.emitter.fire());
  }

  refresh(): void {
    this.emitter.fire();
  }

  getTreeItem(element: ActionNode): vscode.TreeItem {
    if (element.kind === 'command') {
      const item = new vscode.TreeItem(element.label, vscode.TreeItemCollapsibleState.None);
      item.iconPath = new vscode.ThemeIcon(element.icon);
      item.command = { command: element.id, title: element.label };
      if (element.description) item.description = element.description;
      return item;
    }

    if (element.kind === 'language') {
      const cfg = readConfig();
      const item = new vscode.TreeItem(
        s().actions.language,
        vscode.TreeItemCollapsibleState.Collapsed
      );
      item.iconPath = new vscode.ThemeIcon('globe');
      item.description = languageLabel(cfg.language);
      item.tooltip = s().actions.languageHint;
      return item;
    }

    const active = readConfig().language === element.value;
    const item = new vscode.TreeItem(languageLabel(element.value), vscode.TreeItemCollapsibleState.None);
    item.iconPath = new vscode.ThemeIcon(active ? 'check' : 'blank');
    if (active) item.description = s().actions.current;
    item.command = {
      command: 'depscan.setLanguage',
      title: element.value,
      arguments: [element.value]
    };
    return item;
  }

  getChildren(element?: ActionNode): ActionNode[] {
    if (!element) return topNodes(this.indexer, this.routeRef);
    if (element.kind === 'language') {
      const values: UiLanguage[] = ['auto', 'zh', 'en'];
      return values.map((value) => ({ kind: 'language-choice', value }));
    }
    return [];
  }

  dispose(): void {
    this.routeSub?.dispose();
    this.emitter.dispose();
  }
}

/** 顺序按使用频率排：先导航，再索引维护，再导出，最后设置与帮助 */
function topNodes(indexer: IndexService, route?: RouteTreeProvider): ActionNode[] {
  const t = s().actions;
  const stats = indexer.currentStatus.stats;
  return [
    { kind: 'command', id: 'depscan.showRoute', label: t.route, icon: 'list-ordered' },
    { kind: 'command', id: 'depscan.routeFromCursor', label: t.routeFromCursor, icon: 'target' },
    { kind: 'command', id: 'depscan.showRouteDiagram', label: t.routeDiagram, icon: 'graph' },
    // 只有起点真的被改过才显示「回去」，否则这一行是噪音
    ...(route?.customStart
      ? [{ kind: 'command', id: 'depscan.resetRouteStart', label: t.resetRouteStart, icon: 'home' } as ActionNode]
      : []),
    { kind: 'command', id: 'depscan.showGraph', label: t.graph, icon: 'type-hierarchy' },
    { kind: 'command', id: 'depscan.showGraphForSymbol', label: t.symbolGraph, icon: 'symbol-method' },
    { kind: 'command', id: 'depscan.showArchitecture', label: t.architecture, icon: 'list-tree' },
    {
      kind: 'command',
      id: 'depscan.indexWorkspace',
      label: t.reindex,
      icon: 'refresh',
      // 把当前精度直接摆在侧边栏，不必打开面板才知道是精确还是近似
      description: stats ? precisionLabel(stats.precision) : undefined
    },
    { kind: 'command', id: 'depscan.cancelIndex', label: t.cancelIndex, icon: 'stop' },
    { kind: 'command', id: 'depscan.clearCache', label: t.clearCache, icon: 'trash' },
    { kind: 'command', id: 'depscan.exportJson', label: t.exportJson, icon: 'export' },
    {
      kind: 'command',
      id: 'depscan.exportImage',
      label: t.exportImage,
      icon: 'file-media',
      description: t.exportImageHint
    },
    { kind: 'language' },
    { kind: 'command', id: 'depscan.prepareCompileCommands', label: t.compileGuide, icon: 'book' },
    { kind: 'command', id: 'depscan.diagnosePrecision', label: t.diagnosePrecision, icon: 'question' },
    // 边界检查：平时索引完自动跑（结果在「问题」面板），这一行是显式入口
    { kind: 'command', id: 'depscan.checkBoundaries', label: t.checkBoundaries, icon: 'shield' },
    { kind: 'command', id: 'depscan.openDocs', label: t.docs, icon: 'book' }
  ];
}
