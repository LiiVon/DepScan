import * as vscode from 'vscode';

import { precisionHint, precisionLabel, s } from '../i18n';
import type { IndexService, IndexStatus } from '../index/indexer';

/** 状态栏：索引进度 / 就绪统计 / 引擎错误。点击打开索引详情。 */
export class StatusBar implements vscode.Disposable {
  private readonly item: vscode.StatusBarItem;
  private readonly disposable: vscode.Disposable;
  private readonly indexer: IndexService;

  constructor(indexer: IndexService) {
    this.item = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 90);
    this.item.command = 'depscan.showIndexStatus';
    this.item.show();
    this.indexer = indexer;
    this.disposable = indexer.onDidChangeStatus.event((status) => this.update(status));
    this.update(indexer.currentStatus);
  }

  /** 语言切换后重绘文案 */
  refresh(): void {
    this.update(this.indexer.currentStatus);
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
        const label = stats ? precisionLabel(stats.precision) : '';
        this.item.text = stats
          ? `$(type-hierarchy) DepScan ${stats.fileCount} 文件 / ${stats.edgeCount} 依赖 · ${label}`
          : '$(type-hierarchy) DepScan';
        const hint = stats ? precisionHint(stats.precision) : s().precision.approxHint;
        this.item.tooltip = `${status.message}\n${hint}`;
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
