import type { Strings } from './types';

export const zh: Strings = {
  index: {
    starting: '正在建立索引…',
    progress: (done, total, file) => `索引中 ${done}/${total} · ${file}`,
    done: (stats) => `索引完成：${stats.fileCount} 个文件，${stats.edgeCount} 条依赖`,
    summary: (stats) =>
      `${stats.fileCount} 文件 · ${stats.symbolCount} 符号 · ${stats.edgeCount} 依赖 · 耗时 ${Math.round(
        stats.elapsedMs
      )}ms`,
    cancelled: '已取消索引',
    failed: (message) => `索引失败：${message}`,
    noWorkspace: '请先打开一个文件夹（工作区）再使用 DepScan。',
    alreadyRunning: '已有索引任务在执行，请先取消或等待完成。',
    watchReindex: (file) => `文件变更，正在增量更新：${file}`,
    incremental: (file, changed) => `已增量更新 ${file}（受影响子图 ${changed} 处）`
  },
  engine: {
    missing: '未找到 DepScan 分析引擎可执行文件。',
    missingHint: '请在 settings.json 中设置 depscan.engine.path 指向 depscan-core，或在 engine/ 下编译引擎。',
    startFailed: (message) => `引擎启动失败：${message}`,
    crashed: (message) => `引擎进程异常退出：${message}`,
    notStarted: '引擎尚未启动',
    stopped: '引擎已停止'
  },
  graph: {
    title: (label) => `DepScan 依赖图 · ${label}`,
    depth: '层级 k',
    direction: '方向',
    both: '双向',
    upstream: '被谁依赖',
    downstream: '依赖了谁',
    viewGraph: '图',
    viewTree: '树',
    viewTable: '表格',
    showExternal: '显示项目外符号',
    cluster: '按目录聚类',
    refresh: '刷新',
    truncated: (shown) => `节点过多，已按性能上限显示 ${shown} 个（可减小 k 或使用搜索定位）`,
    empty: '当前焦点没有可展示的依赖。',
    loading: '正在加载依赖数据…',
    search: '搜索节点…',
    focusLabel: '焦点',
    hint: '拖动节点 · 滚轮缩放 · 空白处平移 · 双击节点下钻 · 单击节点跳转源码',
    stats: (stats) =>
      `${stats.fileCount} 文件 · ${stats.edgeCount} 依赖 · ${stats.precision === 'exact' ? '精确解析' : '近似解析'}`,
    exportPng: '导出 PNG',
    exportSvg: '导出 SVG',
    exportJson: '导出 JSON',
    exportDot: '导出 DOT',
    exportMermaid: '导出 Mermaid',
    exported: (path) => `已导出：${path}`,
    expandHint: '双击展开下一层',
    legend: '图例',
    fit: '适应窗口',
    architecture: '全局架构视图（按目录聚合）',
    clickToOpen: '点击跳转源码',
    directions: '方向'
  },
  table: {
    node: '节点',
    kind: '类型',
    outDeps: '出依赖',
    inDeps: '入依赖',
    file: '文件',
    precision: '精度'
  },
  precision: {
    exact: '精确',
    approx: '近似',
    exactHint: '基于 compile_commands.json 的编译参数解析（路径与宏均来自真实构建）',
    approxHint: '未提供 compile_commands.json，使用内置结构解析，结果可能有误报/漏报'
  },
  cache: {
    cleared: '索引缓存已清理',
    none: '没有可清理的缓存'
  },
  errors: {
    noActiveFile: '当前没有打开的 C/C++ 文件。',
    unsupportedFile: 'DepScan 只支持 C/C++ 源文件与头文件。',
    focusMissing: (message) => `无法定位依赖焦点：${message}`,
    exportFailed: (message) => `导出失败：${message}`,
    noData: '尚未建立索引，请先执行「重建索引」。'
  },
  docs: {
    missing: '未找到文档目录 docs/。'
  },
  compile: {
    guideTitle: '生成 compile_commands.json',
    guideBody: [
      '有 compile_commands.json 时，DepScan 使用真实编译参数做精确解析；否则自动降级为内置结构解析（近似精度）。',
      '',
      'CMake：',
      '  cmake -S . -B build -DCMAKE_EXPORT_COMPILE_COMMANDS=ON',
      '',
      'Ninja / Makefile：',
      '  bear -- make        # 或  ninja -t compdb cxx cc > compile_commands.json',
      '',
      'Bazel：',
      '  bazel run @hedron_compile_commands//:refresh_all',
      '',
      'qmake：',
      '  qmake -compile-commands  (Qt 5.12+)',
      '',
      'Xcode：',
      '  使用 xcpretty -r json-compilation-database',
      '',
      '生成后把 compile_commands.json 放到项目根目录（或设置 depscan.compile.commandsPath）。'
    ].join('\n'),
    copy: '复制命令',
    copied: '已复制到剪贴板'
  },
  kinds: {
    file: '文件',
    function: '函数',
    class: '类',
    enum: '枚举',
    variable: '变量',
    macro: '宏',
    target: '构建目标',
    unknown: '未知'
  },
  edgeKinds: {
    includes: '包含',
    calls: '调用',
    inherits: '继承',
    uses: '类型',
    refs: '引用',
    links: '链接'
  },
  precisionLabel: (p) => (p === 'exact' ? '精确' : '近似')
};
