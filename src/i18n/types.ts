// 运行期 UI 文案（命令标题与配置描述在 package.nls*.json 中，由 VS Code 本地化机制处理）
import type { EdgeKind, NodeKind, Precision, ScanStats } from '../graph/model';

export interface Strings {
  index: {
    starting: string;
    progress: (done: number, total: number, file: string) => string;
    done: (stats: ScanStats) => string;
    summary: (stats: ScanStats) => string;
    cancelled: string;
    failed: (message: string) => string;
    noWorkspace: string;
    alreadyRunning: string;
    watchReindex: (file: string) => string;
    incremental: (file: string, changed: number) => string;
    compileDbChanged: string;
    cacheReused: string;
    precisionNow: (label: string) => string;
  };
  engine: {
    missing: string;
    missingHint: string;
    startFailed: (message: string) => string;
    crashed: (message: string) => string;
    notStarted: string;
    stopped: string;
  };
  graph: {
    title: (label: string) => string;
    depth: string;
    direction: string;
    both: string;
    upstream: string;
    downstream: string;
    viewGraph: string;
    viewTree: string;
    viewTable: string;
    showExternal: string;
    cluster: string;
    refresh: string;
    truncated: string; // 含 {n} 占位符
    statsLine: string; // 含 {n} {e} 占位符
    empty: string;
    loading: string;
    search: string;
    focusLabel: string;
    hint: string;
    stats: (stats: ScanStats) => string;
    exportPng: string;
    exportSvg: string;
    exportJson: string;
    exportDot: string;
    exportMermaid: string;
    exported: (path: string) => string;
    expandHint: string;
    legend: string;
    fit: string;
    architecture: string;
    clickToOpen: string;
    directions: string;
  };
  table: {
    node: string;
    kind: string;
    outDeps: string;
    inDeps: string;
    file: string;
    precision: string;
  };
  precision: {
    exact: string;
    partial: string;
    approx: string;
    exactHint: string;
    partialHint: string;
    approxHint: string;
  };

  /** 「为什么是近似？」精度诊断命令的文案 */
  diagnostic: {
    title: string;
    project: (root: string) => string;
    engine: (path: string, source: string) => string;
    libclang: (available: boolean) => string;
    compileDb: (path: string) => string;
    compileDbEntries: (n: number) => string;
    compileDbMissing: string;
    buildDirWithoutDb: (dirs: string) => string;
    searched: (dirs: string) => string;
    precision: (label: string, hint: string) => string;
    includes: (exact: number, approx: number) => string;
    symbols: (exact: number, approx: number) => string;
    cache: (reused: boolean, path: string) => string;
    notIndexed: string;
    nextHeader: string;
    nextScan: string;
    nextBuild: string;
    nextRescan: string;
    nextClang: string;
    nextOk: string;
    rescan: string;
    openGuide: string;
  };
  cache: {
    cleared: string;
    none: string;
  };
  errors: {
    noActiveFile: string;
    unsupportedFile: string;
    focusMissing: (message: string) => string;
    exportFailed: (message: string) => string;
    noData: string;
  };
  docs: {
    missing: string;
  };
  compile: {
    guideTitle: string;
    guideBody: string;
    copy: string;
    copied: string;
  };
  kinds: Record<NodeKind, string>;
  edgeKinds: Record<EdgeKind, string>;
  precisionLabel: (p: Precision) => string;
  /** 侧边栏「操作」视图 */
  actions: {
    graph: string;
    symbolGraph: string;
    architecture: string;
    reindex: string;
    cancelIndex: string;
    clearCache: string;
    exportJson: string;
    exportImage: string;
    exportImageHint: string;
    language: string;
    languageAuto: string;
    languageZh: string;
    languageEn: string;
    languageHint: string;
    compileGuide: string;
    diagnosePrecision: string;
    docs: string;
    current: string;
  };
}
