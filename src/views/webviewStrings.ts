import type { Strings } from '../i18n/types';

/**
 * 把运行期文案打平成 Webview 使用的扁平 key/value。
 * 纯函数、不依赖 vscode —— 这样插件、离线自检脚本、离线预览页
 * 都从**同一份** Strings 生成，不会出现"预览页和真实界面文案不一致"。
 */
export function buildWebviewStrings(t: Strings): Record<string, string> {
  const i18n: Record<string, string> = {
    loading: t.graph.loading,
    empty: t.graph.empty,
    hint: t.graph.hint,
    'graph.depth': t.graph.depth,
    'graph.direction': t.graph.direction,
    'graph.both': t.graph.both,
    'graph.upstream': t.graph.upstream,
    'graph.downstream': t.graph.downstream,
    'graph.showExternal': t.graph.showExternal,
    'graph.cluster': t.graph.cluster,
    'graph.clickToOpen': t.graph.clickToOpen,
    'graph.fit': t.graph.fit,
    'graph.architecture': t.graph.architecture,
    'graph.refresh': t.graph.refresh,
    'graph.search': t.graph.search,
    'graph.focusLabel': t.graph.focusLabel,
    'graph.truncated': t.graph.truncated,
    'graph.statsLine': t.graph.statsLine,
    'graph.viewGraph': t.graph.viewGraph,
    'graph.viewTree': t.graph.viewTree,
    'graph.viewTable': t.graph.viewTable,
    'graph.legend': t.graph.legend,
    'graph.exportPng': t.graph.exportPng,
    'graph.exportSvg': t.graph.exportSvg,
    'graph.exportJson': t.graph.exportJson,
    'graph.exportDot': t.graph.exportDot,
    'graph.exportMermaid': t.graph.exportMermaid,
    'graph.language': t.actions.language,
    'graph.languageAuto': t.actions.languageAuto,
    'graph.languageZh': t.actions.languageZh,
    'graph.languageEn': t.actions.languageEn,
    'table.node': t.table.node,
    'table.kind': t.table.kind,
    'table.outDeps': t.table.outDeps,
    'table.inDeps': t.table.inDeps,
    'table.file': t.table.file,
    'table.precision': t.table.precision,
    'precision.exact': t.precision.exact,
    'precision.partial': t.precision.partial,
    'precision.approx': t.precision.approx
  };
  for (const [kind, label] of Object.entries(t.kinds)) i18n[`kind.${kind}`] = label;
  for (const [kind, label] of Object.entries(t.edgeKinds)) i18n[`edge.${kind}`] = label;
  return i18n;
}
