import * as path from 'path';
import * as vscode from 'vscode';

import type { Direction } from '../engine/protocol';
import type { GraphData, GraphNode, NodeKind } from '../graph/model';
import { s } from '../i18n';
import type { IndexService, IndexStatus } from '../index/indexer';

type IndexTreeElement = { kind: 'status' } | { kind: 'stat'; label: string; value: string } | { kind: 'warning'; text: string };

/** 侧边栏「索引状态」视图：进度、统计、警告与操作入口 */
export class IndexTreeProvider implements vscode.TreeDataProvider<IndexTreeElement>, vscode.Disposable {
  private readonly emitter = new vscode.EventEmitter<IndexTreeElement | undefined | void>();
  readonly onDidChangeTreeData = this.emitter.event;

  constructor(private readonly indexer: IndexService) {
    this.indexer.onDidChangeStatus.event(() => this.emitter.fire());
  }

  refresh(): void {
    this.emitter.fire();
  }

  getTreeItem(element: IndexTreeElement): vscode.TreeItem {
    if (element.kind === 'status') {
      const status = this.indexer.currentStatus;
      const item = new vscode.TreeItem(statusLabel(status), vscode.TreeItemCollapsibleState.None);
      item.iconPath = new vscode.ThemeIcon(statusIcon(status));
      item.tooltip = status.message || statusLabel(status);
      item.contextValue = 'depscan.status';
      return item;
    }
    if (element.kind === 'warning') {
      const item = new vscode.TreeItem(element.text, vscode.TreeItemCollapsibleState.None);
      item.iconPath = new vscode.ThemeIcon('warning');
      return item;
    }
    const item = new vscode.TreeItem(`${element.label}：${element.value}`, vscode.TreeItemCollapsibleState.None);
    item.iconPath = new vscode.ThemeIcon('symbol-field');
    return item;
  }

  getChildren(element?: IndexTreeElement): IndexTreeElement[] {
    if (element) return [];
    const status = this.indexer.currentStatus;
    const out: IndexTreeElement[] = [{ kind: 'status' }];
    const stats = status.stats;
    if (stats) {
      out.push({ kind: 'stat', label: s().table.file, value: String(stats.fileCount) });
      out.push({ kind: 'stat', label: '符号', value: String(stats.symbolCount) });
      out.push({ kind: 'stat', label: '依赖', value: String(stats.edgeCount) });
      out.push({
        kind: 'stat',
        label: s().table.precision,
        value: stats.compileCommandsFound ? s().precision.exact : s().precision.approx
      });
      out.push({ kind: 'stat', label: '耗时', value: `${Math.round(stats.elapsedMs)} ms` });
      out.push({
        kind: 'stat',
        label: 'compile_commands',
        value: stats.compileCommandsFound ? path.basename(stats.compileCommandsPath) : '—'
      });
      for (const w of stats.warnings ?? []) out.push({ kind: 'warning', text: w });
    }
    const engine = this.indexer.engineLocation;
    if (engine) out.push({ kind: 'stat', label: '引擎来源', value: engine.source });
    return out;
  }

  dispose(): void {
    this.emitter.dispose();
  }
}

function statusLabel(status: IndexStatus): string {
  switch (status.state) {
    case 'indexing': {
      const total = status.total > 0 ? status.total : '?';
      return `${s().index.starting} ${status.done}/${total}`;
    }
    case 'ready':
      return status.message || s().index.done(status.stats!);
    case 'error':
      return status.message;
    default:
      return s().engine.notStarted;
  }
}

function statusIcon(status: IndexStatus): string {
  switch (status.state) {
    case 'indexing':
      return 'sync~spin';
    case 'ready':
      return 'check';
    case 'error':
      return 'error';
    default:
      return 'circle-outline';
  }
}

// ------------------------------ 依赖树 ------------------------------

interface DependencyNode {
  kind: 'group' | 'node' | 'info';
  id?: string;
  label: string;
  direction?: Direction;
  graphNode?: GraphNode;
  depth: number;
}

/** 侧边栏「依赖」视图：当前文件的双向依赖树，可逐层展开 */
export class DependencyTreeProvider implements vscode.TreeDataProvider<DependencyNode>, vscode.Disposable {
  private readonly emitter = new vscode.EventEmitter<DependencyNode | undefined | void>();
  readonly onDidChangeTreeData = this.emitter.event;
  private focusRel: string | undefined;
  private readonly childrenCache = new Map<string, GraphData>();

  constructor(private readonly indexer: IndexService) {
    this.indexer.onDidUpdateGraph.event(() => {
      this.childrenCache.clear();
      this.emitter.fire();
    });
    vscode.window.onDidChangeActiveTextEditor(() => {
      const rel = this.indexer.activeRelFile()?.rel;
      if (rel !== this.focusRel) {
        this.focusRel = rel;
        this.childrenCache.clear();
        this.emitter.fire();
      }
    });
  }

  refresh(rel?: string): void {
    this.focusRel = rel ?? this.indexer.activeRelFile()?.rel;
    this.childrenCache.clear();
    this.emitter.fire();
  }

  currentFocus(): string | undefined {
    return this.focusRel;
  }

  getTreeItem(element: DependencyNode): vscode.TreeItem {
    const collapsible =
      element.kind === 'info'
        ? vscode.TreeItemCollapsibleState.None
        : element.depth >= 3
          ? vscode.TreeItemCollapsibleState.None
          : vscode.TreeItemCollapsibleState.Collapsed;
    const item = new vscode.TreeItem(element.label, collapsible);
    if (element.graphNode) {
      const node = element.graphNode;
      item.description = `${s().kinds[node.kind as NodeKind]}${node.external ? ' · ext' : ''}`;
      item.tooltip = `${node.name}\n${node.file}:${node.line}\n${node.detail}`;
      item.iconPath = new vscode.ThemeIcon('symbol-method', new vscode.ThemeColor('charts.blue'));
      item.contextValue = 'depscan.depNode';
      if (node.file) {
        item.command = {
          command: 'depscan.openNode',
          title: 'open',
          arguments: [node.file, node.line, node.column]
        };
      }
    } else if (element.kind === 'group') {
      item.iconPath = new vscode.ThemeIcon(element.direction === 'upstream' ? 'arrow-up' : 'arrow-down');
      item.contextValue = 'depscan.depGroup';
    }
    return item;
  }

  async getChildren(element?: DependencyNode): Promise<DependencyNode[]> {
    const focus = this.focusRel ?? this.indexer.activeRelFile()?.rel;
    if (!element) {
      if (!focus) {
        return [{ kind: 'info', label: s().errors.noActiveFile, depth: 0 }];
      }
      this.focusRel = focus;
      return [
        { kind: 'group', label: s().graph.upstream, direction: 'upstream', depth: 0, id: focus },
        { kind: 'group', label: s().graph.downstream, direction: 'downstream', depth: 0, id: focus }
      ];
    }
    if (element.kind === 'info') return [];
    if (element.kind === 'group') {
      const children = await this.neighbors(element.id!, element.direction!);
      if (children.length === 0) {
        return [{ kind: 'info', label: s().graph.empty, depth: element.depth + 1 }];
      }
      return children;
    }
    if (element.depth >= 3 || !element.id) return [];
    const children = await this.neighbors(element.id, element.direction ?? 'both');
    return children;
  }

  private async neighbors(id: string, direction: Direction): Promise<DependencyNode[]> {
    const cacheKey = `${id}\u0001${direction}`;
    let graph = this.childrenCache.get(cacheKey);
    if (!graph) {
      const result = await this.indexer.subgraph(id, 1, direction);
      graph = result?.graph ?? { nodes: [], edges: [] };
      this.childrenCache.set(cacheKey, graph);
    }
    const parents = new Map<string, DependencyNode>();
    const currentNode = graph.nodes.find((n) => n.id === id);
    const skip = new Set<string>([id, currentNode?.file ? `file:${currentNode.file}` : '']);
    for (const edge of graph.edges) {
      const otherId = edge.from === id ? edge.to : edge.from;
      if (skip.has(otherId)) continue;
      const node = graph.nodes.find((n) => n.id === otherId);
      if (!node) continue;
      parents.set(otherId, {
        kind: 'node',
        id: node.id,
        label: node.name,
        direction,
        graphNode: node,
        depth: 1
      });
    }
    return [...parents.values()].slice(0, 200);
  }

  dispose(): void {
    this.emitter.dispose();
  }
}
