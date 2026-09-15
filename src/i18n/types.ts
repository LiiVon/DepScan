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
    /** 详情里的「公开接口」字段标签 */
    publicApi: string;
    /** 节点上的角标（要短，表格/树里都会用） */
    apiBadge: string;
    /** 图例里的说明 */
    apiLegend: string;
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
    /** 架构边界检查（公开面泄漏 / 目录成环） */
    checkBoundaries: string;
    /** 命令里用的「打开问题面板」按钮 */
    showProblems: string;
    route: string;
    routeFromCursor: string;
    resetRouteStart: string;
    routeDiagram: string;
    docs: string;
    current: string;
  };

  /** 侧边栏「阅读路线」视图 */
  route: {
    /** 空视图提示：还没有索引 */
    needIndex: string;
    /** 库项目没有 main 时：把「从哪读起」的候选列出来 */
    noMainHint: string;
    /** 有 main 时的候选列表标题（调试出口用） */
    entryCandidates: (n: number) => string;
    /** 候选列表的排序依据（tooltip） */
    entryHint: string;
    /** 候选行的动作 */
    startFromHere: string;
    /** 候选是公开接口：它的声明在哪 */
    publicApiLine: (file: string, line: number) => string;
    /** 项目里有多少处调用它（0 = 没人调用，所以它像入口） */
    entryCallers: (n: number) => string;
    /** 它会调到多少个函数 */
    entryCallees: (n: number) => string;
    /** 自动找入口失败（库项目没有 main） */
    noEntry: string;
    /** 查询失败 */
    failed: string;
    /** 起点说明，例：起点：main（自动识别） */
    from: (name: string, file: string) => string;
    /** 手动指定起点时的说明，例：起点：Engine::run（来自光标，src/core/engine.cpp:29） */
    fromPicked: (name: string, file: string) => string;
    /** 起点无法使用限定名时的兑底：起点：main */
    fromShort: (name: string) => string;
    /** 已经是最高优先级 / 根节点 */
    root: string;
    /** 步号前缀，例：#3 */
    step: (order: number) => string;
    /** 该步有同名定义，按名字消解可能选错了 */
    ambiguous: string;
    /** 同名定义候选分组标题，例：候选（另有 2 个同名定义） */
    candidates: (n: number) => string;
    /** 候选里当前正在用的那一个 */
    current: string;
    /** 候选条目的提示，例：改用 src/core/base.h:25 作为这一步 */
    useCandidate: (file: string, line: number) => string;
    /** 候选条目就是当前用的那个 → 点它是撤回纠偏 */
    resetCandidate: string;
    /** 视图顶部提示：有 N 步存在同名定义 */
    candidateHint: (n: number) => string;
    /** 光标处没有可用符号 */
    cursorMissing: (file: string, line: number) => string;
    /** 泳道图的名称（命令标题 / 树条目） */
    diagram: string;
    /** 泳道图面板标题，例：阅读路线 · main */
    diagramTitle: (from: string) => string;
    /** 面板顶部说明：横轴是什么、箭头是什么意思 */
    diagramHint: string;
    /** 面板顶部第二行：怎么操作这张图（拖拽/滚轮/键盘） */
    diagramNavHint: string;
    /** 规模行，例：13 步 · 9 个文件 · 11 次换文件 */
    diagramStatus: (steps: number, lanes: number, cross: number) => string;
    /** 因为超过绘图上限没画出来的步骤 */
    diagramTruncated: (drawn: number, total: number) => string;
    /** 导出 SVG 成功 */
    diagramExported: (file: string) => string;
    /** 没有路线可画 */
    diagramEmpty: string;
    diagramFit: string;
    diagramZoomIn: string;
    diagramZoomOut: string;
    diagramReset: string;
    diagramExport: string;
    diagramRefresh: string;
    diagramLegend: string;
    diagramLegendStep: string;
    diagramLegendAmbiguous: string;
    diagramLegendCross: string;
    diagramLegendSame: string;
    /** 项目外符号（关掉 projectOnly 才出现） */
    external: string;
    /** 首次进入某文件 */
    newFile: string;
    /** 层视图：层号的含义（分组行的 tooltip） */
    layerLegend: string;
    /** 层视图：第 N 层分组标题，例：第 2 层 · 4 个步骤 / 3 个文件 */
    layer: (layer: number, steps: number, files: number) => string;
    /** 层视图：这一层里有 N 个步骤存在同名定义 */
    layerRisky: (n: number) => string;
    /** 层视图：一层被分页藏起来的步骤，例：还有 12 个未列出 —— 点这里继续展开 */
    moreInLayer: (hidden: number) => string;
    /** 层视图：分页行的 tooltip */
    moreInLayerHint: string;
    /** 这一步由谁调起，例：由 #3 Application::start 调起 */
    calledFrom: (order: number, name: string) => string;
    /** 被截断时的尾部提示，例：还有 137 个函数/9 个文件未展开 */
    truncated: (nodes: number, files: number) => string;
    /** 生成完整了 */
    complete: string;
    /** 视图顶部：已折叠 N 个琐碎步骤 */
    trimmed: (n: number) => string;
    /** tooltip：这一步的函数体有多大 */
    bodyLines: (n: number) => string;
    /** tooltip：这一步里被折叠掉的名字 */
    skippedNames: (names: string[]) => string;
    /** 刚打开降噪时的状态栏提示 */
    hideTrivial: string;
    /** 刚关掉降噪时的状态栏提示 */
    showTrivial: string;
    /** 切换「只显示每个文件首次进入」的按钮文案 */
    toggleGroupByFile: string;
    /** 切换「按层分组」的按钮文案 */
    toggleByLayer: string;
    /** 切换遍历策略的按钮文案 */
    toggleStrategy: string;
    /** 策略当前值 */
    bfs: string;
    dfs: string;
    /** 重新生成 */
    regenerate: string;
    /** 提示：路线是阅读建议，不是精确调用栈 */
    precisionHint: string;
  };

  /** 架构边界检查（公开面泄漏 / 目录成环） */
  checks: {
    /** 公开头文件引用了内部实现 */
    leak: (file: string) => string;
    /** 目录之间成环 */
    cycle: (dirs: string, edges: number) => string;
    /** 一个都没找到 */
    none: string;
    /** 汇总：共 total 处（leaks 泄漏 / cycles 环） */
    found: (total: number, leaks: number, cycles: number) => string;
    /** 列表被截断时如实说 */
    foundTruncated: (total: number, shown: number) => string;
    /** 开关被关掉时的提示 */
    disabled: string;
  };
}
