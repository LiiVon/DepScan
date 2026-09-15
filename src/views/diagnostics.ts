import * as path from 'path';
import * as vscode from 'vscode';

import { readConfig } from '../config';
import type { ViolationsResult } from '../engine/protocol';
import type { IndexService } from '../index/indexer';
import type { Logger } from '../util/log';
import { violationDiagnostics } from './violationModel';

/** 模型给的是字符串（能在 Node 里断言），这里映射到 vscode 的枚举 */
function toSeverity(level: 'warning' | 'error'): vscode.DiagnosticSeverity {
  return level === 'error' ? vscode.DiagnosticSeverity.Error : vscode.DiagnosticSeverity.Warning;
}

/**
 * 把架构边界违规（公开面泄漏 / 目录成环）报到「问题」面板。
 *
 * 为什么用诊断而不是自建列表：
 *  - 点一下就能跳到那一行（自建列表还得自己实现跳转）
 *  - 「问题」面板里能按文件分组、按 code 筛选 —— 这两件都是现成的
 *  - 别人写 CI 时可以直接 grep `depscaner.` 这个 code 前缀
 *
 * 每次都**整份重算**：增量更新只改了少数文件，但「目录成环」是全局属性 ——
 * 只想更新受影响的那几条，很容易留下幽灵（边没了、诊断还在）。
 */
export class BoundaryDiagnostics implements vscode.Disposable {
  private readonly collection = vscode.languages.createDiagnosticCollection('depscaner');
  private lastTotal = 0;

  constructor(
    private readonly indexer: IndexService,
    private readonly logger: Logger
  ) {}

  /** 最近一次检查发现的违规数（0 = 干净） */
  get total(): number {
    return this.lastTotal;
  }

  /**
   * 重新检查并刷新「问题」面板。
   * 关掉开关时会把已有诊断**清掉** —— 否则面板里会留着一堆再也不会更新的红点。
   */
  async refresh(): Promise<ViolationsResult | undefined> {
    if (!readConfig().checksBoundaryViolations || !this.indexer.currentStatus.stats) {
      this.clear();
      return undefined;
    }
    const result = await this.indexer.violations();
    if (!result) return undefined;   // 查询失败：保留上一次结果，别把面板清空误导用户

    const root = this.indexer.root;
    const byFile = new Map<string, vscode.Diagnostic[]>();
    for (const d of violationDiagnostics(result)) {
      const abs = root && !path.isAbsolute(d.file) ? path.join(root, d.file) : d.file;
      const line = Math.max(0, d.line - 1);
      const list = byFile.get(abs) ?? [];
      list.push({
        range: new vscode.Range(line, 0, line, Number.MAX_SAFE_INTEGER),
        message: d.message,
        severity: toSeverity(d.severity),
        code: d.code,
        source: 'DepScaner'
      });
      byFile.set(abs, list);
    }
    this.collection.clear();
    for (const [file, list] of byFile) {
      this.collection.set(vscode.Uri.file(file), list);
    }
    this.lastTotal = result.total;
    this.logger.info(`架构边界检查：${result.total} 处，落在 ${byFile.size} 个文件里`);
    return result;
  }

  clear(): void {
    this.collection.clear();
    this.lastTotal = 0;
  }

  dispose(): void {
    this.collection.dispose();
  }
}