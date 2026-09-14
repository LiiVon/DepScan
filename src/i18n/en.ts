import type { Strings } from './types';

export const en: Strings = {
  index: {
    starting: 'Building index…',
    progress: (done, total, file) => `Indexing ${done}/${total} · ${file}`,
    done: (stats) => `Index done: ${stats.fileCount} files, ${stats.edgeCount} edges`,
    summary: (stats) =>
      `${stats.fileCount} files · ${stats.symbolCount} symbols · ${stats.edgeCount} edges · ${Math.round(
        stats.elapsedMs
      )}ms`,
    cancelled: 'Indexing cancelled',
    failed: (message) => `Indexing failed: ${message}`,
    noWorkspace: 'Open a folder before using DepScan.',
    alreadyRunning: 'An indexing task is already running. Cancel it or wait for completion.',
    watchReindex: (file) => `File changed, updating incrementally: ${file}`,
    incremental: (file, changed) => `Updated ${file} incrementally (${changed} affected nodes)`,
    compileDbChanged: 'compile_commands.json changed — re-indexing for exact results…',
    cacheReused: 'Reused on-disk cache (compile database and options unchanged)',
    precisionNow: (label) => `Re-indexed. Current precision: ${label}`
  },
  engine: {
    missing: 'DepScan analysis engine was not found.',
    missingHint:
      'Set depscan.engine.path to your depscan-core binary, or build it under engine/.',
    startFailed: (message) => `Failed to start engine: ${message}`,
    crashed: (message) => `Engine process exited unexpectedly: ${message}`,
    notStarted: 'Engine not started',
    stopped: 'Engine stopped'
  },
  graph: {
    title: (label) => `DepScan Dependency Graph · ${label}`,
    depth: 'Depth k',
    direction: 'Direction',
    both: 'Both',
    upstream: 'Who depends on me',
    downstream: 'What I depend on',
    viewGraph: 'Graph',
    viewTree: 'Tree',
    viewTable: 'Table',
    showExternal: 'Show external symbols',
    cluster: 'Cluster by directory',
    refresh: 'Refresh',
    truncated: 'Too many nodes; showing {n} (reduce k or use search)',
    statsLine: '{n} nodes · {e} edges',
    empty: 'No dependencies to display for the current focus.',
    loading: 'Loading dependency data…',
    search: 'Search nodes…',
    focusLabel: 'Focus',
    hint: 'Drag nodes · wheel to zoom · drag background to pan · double-click to expand · click to open source',
    stats: (stats) =>
      `${stats.fileCount} files · ${stats.edgeCount} edges · ${stats.precision === 'exact' ? 'exact' : 'approximate'}`,
    exportPng: 'Export PNG',
    exportSvg: 'Export SVG',
    exportJson: 'Export JSON',
    exportDot: 'Export DOT',
    exportMermaid: 'Export Mermaid',
    exported: (path) => `Exported: ${path}`,
    expandHint: 'Double-click to expand',
    legend: 'Legend',
    fit: 'Fit to view',
    architecture: 'Architecture view (grouped by directory)',
    clickToOpen: 'Click to open',
    directions: 'Direction'
  },
  table: {
    node: 'Node',
    kind: 'Kind',
    outDeps: 'Out',
    inDeps: 'In',
    file: 'File',
    precision: 'Precision'
  },
  precision: {
    exact: 'Exact',
    partial: 'Partly exact',
    approx: 'Approx',
    exactHint: 'Engine is linked with Clang: all five dependency kinds are semantic and exact',
    partialHint: 'compile_commands.json found: includes and links are exact; calls / inheritance / types stay structural',
    approxHint: 'No compile_commands.json: everything is structural and may over- or under-report'
  },

  diagnostic: {
    title: 'DepScan precision diagnosis',
    project: (root) => `Project root: ${root}`,
    engine: (path, source) => `Engine: ${path} (source: ${source})`,
    libclang: (ok) => `Clang semantic analysis: ${ok ? 'enabled' : 'disabled (engine built without libclang)'}`,
    compileDb: (p) => `Compile database: found -> ${p}`,
    compileDbEntries: (n) => `  entries: ${n} (include paths and defines come from the real build)`,
    compileDbMissing: 'Compile database: compile_commands.json not found',
    searched: (dirs) => `Looked in:\n${dirs}`,
    precision: (label, hint) => `Current precision: ${label}\n  ${hint}`,
    includes: (exact, approx) => `Include edges: exact ${exact} / approx ${approx}`,
    symbols: (exact, approx) => `Symbols: exact ${exact} / approx ${approx}`,
    cache: (reused, p) => `Cache: ${reused ? 'reused (nothing reparsed)' : 'reparsed'} - ${p}`,
    notIndexed: 'Not indexed yet - run Reindex first.',
    nextHeader: 'What to do next:',
    nextScan: '- Run Reindex once (sidebar: Actions -> Reindex).',
    nextBuild: '- Let your build system export the database: for CMake add set(CMAKE_EXPORT_COMPILE_COMMANDS ON) at the top of CMakeLists.txt (or configure with -DCMAKE_EXPORT_COMPILE_COMMANDS=ON), then re-configure.',
    nextRescan: '- A newer compile_commands.json was detected. Click Reindex below to upgrade precision (existing results predate it).',
    nextClang: '- Includes are already exact; to make calls / inheritance / types exact as well, use an engine build linked against libclang (see docs 04).',
    nextOk: '- Already at the highest precision; nothing to do.',
    rescan: 'Reindex',
    openGuide: 'Setup guide'
  },
  cache: {
    cleared: 'Index cache cleared',
    none: 'No cache to clear'
  },
  errors: {
    noActiveFile: 'No C/C++ file is currently open.',
    unsupportedFile: 'DepScan only supports C/C++ sources and headers.',
    focusMissing: (message) => `Cannot resolve dependency focus: ${message}`,
    exportFailed: (message) => `Export failed: ${message}`,
    noData: 'No index yet. Run "Rebuild Index (Full)" first.'
  },
  docs: {
    missing: 'docs/ directory was not found.'
  },
  compile: {
    guideTitle: 'Generate compile_commands.json',
    guideBody: [
      'With compile_commands.json DepScan parses with real compile arguments (exact). Otherwise it falls back to the built-in structural parser (approximate).',
      '',
      'CMake:',
      '  cmake -S . -B build -DCMAKE_EXPORT_COMPILE_COMMANDS=ON',
      '',
      'Ninja / Makefile:',
      '  bear -- make        # or  ninja -t compdb cxx cc > compile_commands.json',
      '',
      'Bazel:',
      '  bazel run @hedron_compile_commands//:refresh_all',
      '',
      'qmake:',
      '  qmake -compile-commands  (Qt 5.12+)',
      '',
      'Xcode:',
      '  use xcpretty -r json-compilation-database',
      '',
      'Then place compile_commands.json at the project root (or set depscan.compile.commandsPath).'
    ].join('\n'),
    copy: 'Copy command',
    copied: 'Copied to clipboard'
  },
  kinds: {
    file: 'File',
    function: 'Function',
    class: 'Class',
    enum: 'Enum',
    variable: 'Variable',
    macro: 'Macro',
    target: 'Target',
    unknown: 'Unknown'
  },
  actions: {
    graph: 'Show dependency graph (current file)',
    symbolGraph: 'Show dependency graph (current symbol)',
    architecture: 'Architecture view',
    reindex: 'Rebuild index (full)',
    cancelIndex: 'Cancel indexing',
    clearCache: 'Clear index cache',
    exportJson: 'Export dependency data (JSON)',
    exportImage: 'Export dependency graph',
    exportImageHint: 'Use the toolbar inside the graph to export PNG / SVG',
    language: 'UI language',
    languageAuto: 'Follow VS Code',
    languageZh: '中文',
    languageEn: 'English',
    languageHint: 'Affects DepScan UI and messages only; command titles follow the VS Code display language',
    compileGuide: 'How to generate compile_commands.json',
    diagnosePrecision: 'Why is it Approx?',
    docs: 'Documentation',
    current: 'current'
  },
  edgeKinds: {
    includes: 'Includes',
    calls: 'Calls',
    inherits: 'Inherits',
    uses: 'Type',
    refs: 'Refs',
    links: 'Links'
  },
  precisionLabel: (p) => (p === 'exact' ? 'Exact' : 'Approx')
};
