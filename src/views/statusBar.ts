import * as vscode from 'vscode';

import { s } from '../i18n';
import type { IndexService, IndexStatus } from '../index/indexer';

/** 状态栏：索引进度 / 就绪统计 / 引擎错误。点击打开索引详情。 */
export class StatusBar implements vscode.Disposable {
  private readonly item: vscode.StatusBarItem;
  private readonly disposable: vscode.Disposable;

  constructor(indexer: IndexService) {
    this.item = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 90);
    this.item.command = 'depscan.showIndexStatus';
    this.item.show();
    this.disposable = indexer.onDidChangeStatus.event((status) => this.update(status));
    this.update(indexer.currentStatus);
  }

  update(status: IndexStatus): void {
    switch (status.state) {
      case 'indexing': {
        const pct = status.total > 0 ? ` ${Math.round((status.done / status.total) * 100)}%` : '';
        this.item.text = `$(sync~spin) DepScan${pct}`;
        this.item.tooltip = status.message;
        break;
      }
      case 'ready': {
        const stats = status.stats;
        this.item.text = stats ? `$(type-hierarchy) DepScan ${stats.fileCount} 文件 / ${stats.edgeCount} 依赖` : '$(type-hierarchy) DepScan';
        this.item.tooltip = `${status.message}\n${stats?.compileCommandsFound ? s().precision.exactHint : s().precision.approxHint}`;
        break;
      }
      case 'error':
        this.item.text = '$(error) DepScan';
        this.item.tooltip = status.message;
        break;
      default:
        this.item.text = '$(circle-outline) DepScan';
        this.item.tooltip = s().engine.notStarted;
    }
  }

  dispose(): void {
    this.disposable.dispose();
    this.item.dispose();
  }
}
