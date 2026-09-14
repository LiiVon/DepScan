import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';

import { readConfig } from '../config';
import type { Direction } from '../engine/protocol';
import type { GraphData, ScanStats } from '../graph/model';
import { s, currentLanguageTag } from '../i18n';
import type { IndexService } from '../index/indexer';
import type { Logger } from '../util/log';
import type { HostToWebview, WebviewToHost } from '../../webview/types';
import { renderGraphHtml } from './webviewHtml';
import { buildWebviewStrings } from './webviewStrings';

export interface GraphPanelTarget {
  focusId?: string;
  label: string;
  depth?: number;
  direction?: Direction;
  /** 直接以「全局架构视图」打开（无需焦点文件） */
  architecture?: boolean;
}

const STATE_KEY = 'depscan.graphPanelState';

interface SavedPanelState {
  depth?: number;
  direction?: Direction;
  showExternal?: boolean;
  cluster?: boolean;
}

export class GraphPanel {
  private static current: GraphPanel | undefined;

  private readonly disposables: vscode.Disposable[] = [];
  private depth = 2;
  private direction: Direction = 'both';
  private showExternal = false;
  private cluster = false;
  private focusId = '';
  private label = '';
  private mode: 'focus' | 'architecture' = 'focus';
  private lastStats: ScanStats | undefined;

  private constructor(
    private readonly panel: vscode.WebviewPanel,
    private readonly context: vscode.ExtensionContext,
    private readonly indexer: IndexService,
    private readonly logger: Logger
  ) {
    const saved = context.workspaceState.get<SavedPanelState>(STATE_KEY);
    if (saved) {
      this.showExternal = saved.showExternal ?? false;
      this.cluster = saved.cluster ?? false;
    }
    this.depth = Math.max(1, Math.min(6, saved?.depth ?? 2));
    this.direction = saved?.direction ?? 'both';

    this.panel.webview.html = this.buildHtml();

    this.disposables.push(
      this.panel.webview.onDidReceiveMessage((msg: WebviewToHost) => void this.onMessage(msg)),
      this.panel.onDidDispose(() => this.dispose()),
      this.indexer.onDidUpdateGraph.event((e) => {
        this.lastStats = e.stats;
        if (this.focusId) void this.refresh();
      })
    );
  }

  static createOrShow(
    context: vscode.ExtensionContext,
    indexer: IndexService,
    logger: Logger,
    target: GraphPanelTarget
  ): GraphPanel {
    const column = vscode.window.activeTextEditor?.viewColumn ?? vscode.ViewColumn.One;
    if (GraphPanel.current) {
      GraphPanel.current.panel.reveal(column, true);
      GraphPanel.current.applyTarget(target);
      return GraphPanel.current;
    }
    const panel = vscode.window.createWebviewPanel('depscan.graph', s().graph.title(target.label), column, {
      enableScripts: true,
      retainContextWhenHidden: true,
      localResourceRoots: [vscode.Uri.joinPath(context.extensionUri, 'media')]
    });
    GraphPanel.current = new GraphPanel(panel, context, indexer, logger);
    GraphPanel.current.applyTarget(target);
    return GraphPanel.current;
  }

  /** 当前已打开的图面板（语言切换时需要重建它的页面） */
  static get currentPanel(): GraphPanel | undefined {
    return GraphPanel.current;
  }

  private applyTarget(target: GraphPanelTarget): void {
    if (target.focusId) this.focusId = target.focusId;
    this.label = target.label;
    if (target.depth) this.depth = target.depth;
    if (target.direction) this.direction = target.direction;
    this.mode = target.architecture ? 'architecture' : 'focus';
    this.panel.title = s().graph.title(target.label);
    if (target.architecture) void this.loadArchitecture();
    else void this.refresh();
  }

  private async loadArchitecture(): Promise<void> {
    this.mode = 'architecture';
    this.post({ type: 'loading', message: s().graph.loading });
    const result = await this.indexer.architecture();
    if (!result) {
      this.post({ type: 'error', message: s().errors.noData });
      return;
    }
    this.label = s().actions.architecture;
    this.lastGraph = result.graph;
    this.panel.title = s().graph.title(this.label);
    this.post({
      type: 'render',
      graph: result.graph,
      settings: { ...this.settings(), label: this.label },
      truncated: false
    });
  }

  private buildHtml(): string {
    const webview = this.panel.webview;
    const mediaRoot = vscode.Uri.joinPath(this.context.extensionUri, 'media');
    const scriptUri = webview.asWebviewUri(vscode.Uri.joinPath(mediaRoot, 'webview.js'));
    const styleUri = webview.asWebviewUri(vscode.Uri.joinPath(mediaRoot, 'webview.css'));
    return renderGraphHtml({
      cspSource: webview.cspSource,
      scriptUri: scriptUri.toString(),
      styleUri: styleUri.toString(),
      nonce: createNonce(),
      lang: currentLanguageTag(),
      title: s().graph.title(this.label),
      // 与离线自检脚本共用同一个打平函数，避免"预览页和真实界面文案不一致"
      i18n: buildWebviewStrings(s())
    });
  }

  /** 语言变更后重建页面：Webview 的 HTML 是生成式的，只能整体替换 */
  refreshLocalization(): void {
    this.panel.title = s().graph.title(this.label);
    this.panel.webview.html = this.buildHtml();
  }

  private post(message: HostToWebview): void {
    void this.panel.webview.postMessage(message);
  }

  private settings() {
    return {
      depth: this.depth,
      direction: this.direction,
      showExternal: this.showExternal,
      cluster: this.cluster,
      clickToOpen: true,
      focusId: this.focusId,
      label: this.label,
      language: readConfig().language,
      stats: this.lastStats
    };
  }

  private async refresh(): Promise<void> {
    // 架构模式没有焦点文件，重新加载时必须走架构分支（否则会报「无数据」）
    if (this.mode === 'architecture') {
      await this.loadArchitecture();
      return;
    }
    if (!this.focusId) {
      this.post({ type: 'error', message: s().errors.noData });
      return;
    }
    this.post({ type: 'loading', message: s().graph.loading });
    const result = await this.indexer.subgraph(this.focusId, this.depth, this.direction);
    if (!result) {
      this.post({ type: 'error', message: s().errors.noData });
      return;
    }
    if (result.focus) this.focusId = result.focus;
    this.lastGraph = result.graph;
    this.post({
      type: 'render',
      graph: result.graph,
      settings: this.settings(),
      truncated: result.truncated
    });
  }

  private async onMessage(msg: WebviewToHost): Promise<void> {
    switch (msg.type) {
      case 'ready':
        await this.refresh();
        break;
      case 'reload':
        this.depth = Math.max(1, Math.min(6, msg.depth));
        this.direction = msg.direction;
        this.showExternal = msg.showExternal;
        this.persist();
        await this.refresh();
        break;
      case 'setLanguage':
        // 与侧边栏「操作 → 界面语言」走同一条路：只改配置，
        // 真正的刷新由 extension.ts 的配置监听统一处理（含重建本页面）
        await vscode.workspace
          .getConfiguration('depscan')
          .update('ui.language', msg.language, vscode.ConfigurationTarget.Global);
        break;
      case 'expand': {
        const result = await this.indexer.subgraph(msg.id, this.depth, this.direction);
        if (!result) return;
        const merged = mergeGraphs(this.lastGraph ?? { nodes: [], edges: [] }, result.graph);
        this.lastGraph = merged;
        this.post({ type: 'merge', graph: merged, settings: this.settings() });
        break;
      }
      case 'architecture':
        await this.loadArchitecture();
        break;
      case 'open':
        await this.openLocation(msg.file, msg.line, msg.column);
        break;
      case 'exportImage':
        await this.exportImage(msg.format, msg.data, msg.suggestedName);
        break;
      case 'exportData':
        await this.exportData(msg.format);
        break;
      case 'log':
        this.logger.debug(`[webview] ${msg.message}`);
        break;
    }
  }

  private async openLocation(relFile: string, line: number, column: number): Promise<void> {
    const root = this.indexer.root;
    if (!root || !relFile) return;
    const abs = path.isAbsolute(relFile) ? relFile : path.join(root, relFile);
    try {
      const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(abs));
      const editor = await vscode.window.showTextDocument(doc, { preview: true });
      const position = new vscode.Position(Math.max(0, line - 1), Math.max(0, column - 1));
      editor.selection = new vscode.Selection(position, position);
      editor.revealRange(new vscode.Range(position, position), vscode.TextEditorRevealType.InCenterIfOutsideViewport);
    } catch (err) {
      this.logger.warn(`无法打开 ${abs}: ${String(err)}`);
    }
  }

  private async exportImage(format: 'png' | 'svg', data: string, suggestedName: string): Promise<void> {
    try {
      const uri = await vscode.window.showSaveDialog({
        defaultUri: this.defaultExportUri(suggestedName),
        filters: format === 'png' ? { PNG: ['png'] } : { SVG: ['svg'] }
      });
      if (!uri) return;
      if (format === 'png') {
        const base64 = data.replace(/^data:image\/png;base64,/, '');
        await fs.promises.writeFile(uri.fsPath, Buffer.from(base64, 'base64'));
      } else {
        await fs.promises.writeFile(uri.fsPath, data, 'utf8');
      }
      void vscode.window.showInformationMessage(s().graph.exported(uri.fsPath));
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      void vscode.window.showErrorMessage(s().errors.exportFailed(message));
    }
  }

  private async exportData(format: 'json' | 'dot' | 'mermaid'): Promise<void> {
    const result = await this.indexer.exportData(format, this.focusId || undefined, this.depth, this.direction);
    if (!result) {
      void vscode.window.showErrorMessage(s().errors.noData);
      return;
    }
    const ext = format === 'mermaid' ? 'mmd' : format;
    try {
      const uri = await vscode.window.showSaveDialog({
        defaultUri: this.defaultExportUri(`depscan-graph.${ext}`)
      });
      if (!uri) return;
      await fs.promises.writeFile(uri.fsPath, result.content, 'utf8');
      void vscode.window.showInformationMessage(s().graph.exported(uri.fsPath));
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      void vscode.window.showErrorMessage(s().errors.exportFailed(message));
    }
  }

  private defaultExportUri(fileName: string): vscode.Uri {
    const root = this.indexer.root ?? this.context.extensionUri.fsPath;
    return vscode.Uri.file(path.join(root, fileName));
  }

  private lastGraph: GraphData | undefined;

  private persist(): void {
    void this.context.workspaceState.update(STATE_KEY, {
      depth: this.depth,
      direction: this.direction,
      showExternal: this.showExternal,
      cluster: this.cluster
    });
  }

  dispose(): void {
    GraphPanel.current = undefined;
    for (const d of this.disposables) d.dispose();
  }
}

function mergeGraphs(a: GraphData, b: GraphData): GraphData {
  const nodes = new Map(a.nodes.map((n) => [n.id, n]));
  for (const n of b.nodes) nodes.set(n.id, n);
  const edges = new Map(a.edges.map((e) => [`${e.from}\u0001${e.to}\u0001${e.kind}`, e]));
  for (const e of b.edges) edges.set(`${e.from}\u0001${e.to}\u0001${e.kind}`, e);
  return { nodes: [...nodes.values()], edges: [...edges.values()] };
}

function createNonce(): string {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  let text = '';
  for (let i = 0; i < 32; i++) text += chars.charAt(Math.floor(Math.random() * chars.length));
  return text;
}
