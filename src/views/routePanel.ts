import { randomUUID } from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';

import type { SwimlaneToHost, SwimlaneToWebview } from '../../webview/types';
import { currentLanguageTag, s } from '../i18n';
import type { IndexService } from '../index/indexer';
import type { Logger } from '../util/log';
import type { RouteTreeProvider } from './routeProvider';
import { startLabel } from './routeTreeModel';
import { layoutSwimlane, renderSwimlaneSvg } from './swimlane';
import { renderSwimlaneHtml } from './swimlaneHtml';
import { buildSwimlaneStrings } from './webviewStrings';

/** 画布上限：再宽也读不动了。超出部分在状态行里如实报数，不静默丢。 */
const MAX_DRAW_STEPS = 400;

export interface RoutePanelDeps {
  context: vscode.ExtensionContext;
  indexer: IndexService;
  routeTree: RouteTreeProvider;
  logger: Logger;
}

/**
 * 阅读路线的**泳道图**面板。
 *
 * 它是唯一回到画布的地方：TreeView 给的是调用树（谁调了谁），
 * 泳道图给的是「控制权在哪些文件之间来回」—— 跨泳道箭头一眼就能看出来。
 *
 * 数据不自己算：一律走 `RouteTreeProvider.routeSnapshot()`，保证画的与侧边栏
 * 看到的是同一条路线（同一个起点、同一批手工纠偏）。
 */
export class RoutePanel {
  private static current: RoutePanel | undefined;

  private readonly disposables: vscode.Disposable[] = [];
  /** 最近一次生成好的 SVG —— 「导出 SVG」用的就是它，与页面上显示的完全同一份 */
  private svg: string | undefined;
  private title: string;
  private status = '';
  private notice: string | undefined;
  private fromName = '';

  private constructor(
    private readonly panel: vscode.WebviewPanel,
    private readonly deps: RoutePanelDeps
  ) {
    this.title = s().route.diagram;
    this.panel.webview.html = this.buildHtml(s().graph.loading);
    this.disposables.push(
      this.panel.webview.onDidReceiveMessage((msg: SwimlaneToHost) => void this.onMessage(msg)),
      this.panel.onDidDispose(() => this.dispose()),
      // 图变了（重新索引 / 保存文件后的增量更新）→ 重新生成，
      // 否则画出来的可能是已经过期的顺序。
      this.deps.indexer.onDidUpdateGraph.event(() => void this.reload())
    );
    void this.reload();
  }

  static createOrShow(deps: RoutePanelDeps): RoutePanel {
    const column = vscode.window.activeTextEditor?.viewColumn ?? vscode.ViewColumn.One;
    if (RoutePanel.current) {
      RoutePanel.current.panel.reveal(column, true);
      void RoutePanel.current.reload();
      return RoutePanel.current;
    }
    const panel = vscode.window.createWebviewPanel(
      'depscaner.routeDiagram',
      s().route.diagram,
      column,
      {
        enableScripts: true,
        retainContextWhenHidden: true,
        localResourceRoots: [vscode.Uri.joinPath(deps.context.extensionUri, 'media')]
      }
    );
    RoutePanel.current = new RoutePanel(panel, deps);
    return RoutePanel.current;
  }

  /** 当前已打开的泳道图面板（语言切换时需要重建它的页面） */
  static get currentPanel(): RoutePanel | undefined {
    return RoutePanel.current;
  }

  /**
   * 重新生成。
   *
   * `rebuildHtml`：语言切换后必须整体重建页面（HTML 是生成式的），
   * 其它情况只把新的 SVG 送过去 —— 那样**缩放不会被重新生成打回 100%**。
   */
  private async reload(rebuildHtml = false): Promise<void> {
    const snapshot = await this.deps.routeTree.routeSnapshot();
    if (!snapshot || snapshot.result.steps.length === 0) {
      this.svg = undefined;
      this.fromName = '';
      this.title = s().route.diagram;
      this.status = '';
      this.notice = undefined;
      this.panel.title = this.title;
      const empty = s().route.diagramEmpty;
      if (rebuildHtml) this.panel.webview.html = this.buildHtml(empty);
      else this.post({ type: 'empty', message: empty, title: this.title });
      return;
    }

    const layout = layoutSwimlane(snapshot.result, { maxSteps: MAX_DRAW_STEPS });
    // 页面显示与导出用的是同一个字符串：不会出现"导出的和屏幕上不一样"
    this.svg = renderSwimlaneSvg(layout);
    this.fromName = startLabel(snapshot.result.from);
    this.title = s().route.diagramTitle(this.fromName);
    this.status = s().route.diagramStatus(layout.stepCount, layout.lanes.length, layout.crossFileEdges);
    this.notice =
      layout.droppedCount > 0
        ? s().route.diagramTruncated(layout.stepCount, layout.stepCount + layout.droppedCount)
        : undefined;
    this.panel.title = this.title;
    if (rebuildHtml) this.panel.webview.html = this.buildHtml('');
    else
      this.post({
        type: 'svg',
        svg: this.svg,
        title: this.title,
        status: this.status,
        notice: this.notice
      });
  }

  /** 语言变更后重建页面 */
  refreshLocalization(): void {
    void this.reload(true);
  }

  private buildHtml(emptyText: string): string {
    const webview = this.panel.webview;
    const mediaRoot = vscode.Uri.joinPath(this.deps.context.extensionUri, 'media');
    const scriptUri = webview.asWebviewUri(vscode.Uri.joinPath(mediaRoot, 'swimlane.js'));
    return renderSwimlaneHtml({
      cspSource: webview.cspSource,
      scriptUri: scriptUri.toString(),
      nonce: randomUUID().replace(/-/g, ''),
      lang: currentLanguageTag(),
      title: this.title,
      status: this.status,
      notice: this.notice,
      svg: this.svg,
      emptyText,
      // 与离线自检脚本共用同一个打平函数，避免"预览页和真实界面文案不一致"
      i18n: buildSwimlaneStrings(s())
    });
  }

  private post(message: SwimlaneToWebview): void {
    void this.panel.webview.postMessage(message);
  }

  private async onMessage(msg: SwimlaneToHost): Promise<void> {
    if (msg.type === 'open') {
      await vscode.commands.executeCommand('depscaner.openNode', msg.file, msg.line, msg.column);
    } else if (msg.type === 'refresh') {
      await this.reload();
    } else if (msg.type === 'export') {
      await this.exportSvg();
    }
  }

  private async exportSvg(): Promise<void> {
    if (!this.svg) {
      void vscode.window.showWarningMessage(s().route.diagramEmpty);
      return;
    }
    const root = this.deps.indexer.root;
    const uri = await vscode.window.showSaveDialog({
      filters: { SVG: ['svg'] },
      defaultUri: root ? vscode.Uri.file(path.join(root, 'reading-route.svg')) : undefined
    });
    if (!uri) return;
    try {
      await fs.promises.writeFile(uri.fsPath, this.svg, 'utf8');
      void vscode.window.showInformationMessage(s().route.diagramExported(uri.fsPath));
    } catch (err) {
      this.deps.logger.warn(`导出泳道图失败：${String(err)}`);
      void vscode.window.showErrorMessage(String(err));
    }
  }

  private dispose(): void {
    RoutePanel.current = undefined;
    while (this.disposables.length) this.disposables.pop()?.dispose();
  }
}
