// 架构边界违规 → 「问题」面板里那一行（**纯**函数：不 import vscode）。
//
// 为什么把文案单独抽出来：诊断文字是用户唯一能看到的东西，
// 而「诊断要不要报、报成什么级别、code 叫什么」都只能靠肉眼验 ——
// 抽成纯函数之后，这部分就进得了 CI（`scripts/test-checks.mjs`）。
import type { Violation, ViolationsResult } from '../engine/protocol';
import { s } from '../i18n';

export interface ViolationDiagnostic {
  /** 相对路径（适配层再拼成 Uri） */
  file: string;
  /** 1-based 行号 */
  line: number;
  /** 给用户看的那一句 */
  message: string;
  /** 诊断 code：在「问题」面板里可以按它筛选，也便于写进 CI 白名单 */
  code: string;
  /** 模型给字符串（可断言），适配层再映射到 vscode 的枚举 */
  severity: 'warning' | 'error';
}

/**
 * 诊断 code。
 *
 * 带 `depscan.` 前缀是有用的：别人的项目里可能同时跑好几个 linter，
 * 一眼能看出这条是哪来的；要临时忽略也只需要记住一个字符串。
 */
export function violationCode(v: Violation): string {
  return `depscan.${v.kind}`;
}

/**
 * 严重级别：统一用 warning。
 *
 * 这两件事都不是「编译不过」—— 公开面泄漏对**本仓库**编译没影响（在本机它找得到
 * 那个内部头），目录成环也只是一种选择。报成 error 会在「问题」面板里制造红色，
 * 而我们没法代替用户判断他愿不愿意为这个红点改架构。想更严的人可以在 CI 里
 * 用 `depscan-core --violations` 的退出码（有违规即为 1）。
 */
export const VIOLATION_SEVERITY = 'warning' as const;

export function violationDiagnostic(v: Violation): ViolationDiagnostic {
  return {
    file: v.fromFile,
    line: v.fromLine,
    code: violationCode(v),
    severity: VIOLATION_SEVERITY,
    message:
      v.kind === 'directory-cycle'
        ? s().checks.cycle((v.dirs ?? []).join(' ↔ '), v.edgeCount)
        : s().checks.leak(v.toFile)
  };
}

export function violationDiagnostics(result: ViolationsResult): ViolationDiagnostic[] {
  return result.violations.map(violationDiagnostic);
}

/**
 * 汇总一行：命令跑完时的提示。
 *
 * 列表被截断时**如实说**（`total` 才是真实数量）—— 「只列了前 500 个」
 * 与「一共就 500 个」是两件事，混在一起说会让人以为检查是准的。
 */
export function violationsSummary(result: ViolationsResult): string {
  if (result.total === 0) return s().checks.none;
  const leaks = result.violations.filter((v) => v.kind === 'public-api-leak').length;
  const cycles = result.violations.filter((v) => v.kind === 'directory-cycle').length;
  const truncated = result.violations.length < result.total;
  if (truncated) {
    return s().checks.foundTruncated(result.total, result.violations.length);
  }
  return s().checks.found(result.total, leaks, cycles);
}
