// 引擎通信协议（与 engine/src/rpc.cpp 一一对应）
import type { GraphData, NodeKind, Precision, ScanStats } from '../graph/model';

export const PROTOCOL_VERSION = 1;

export interface EngineConfig {
  includes?: boolean;
  calls?: boolean;
  types?: boolean;
  symbols?: boolean;
  links?: boolean;
  includeExternal?: boolean;
  includePaths?: string[];
  systemIncludePaths?: string[];
  defines?: string[];
  includeGlobs?: string[];
  excludeGlobs?: string[];
  fileSizeLimitBytes?: number;
  maxFiles?: number;
  threads?: number;
  compileCommandsPath?: string;
  cachePath?: string;
  useCache?: boolean;
  forceFull?: boolean;
}

export interface PingResult {
  pong: boolean;
  version: string;
  protocol: number;
  scanning: boolean;
}

export interface SubgraphResult {
  graph: GraphData;
  truncated: boolean;
  nodeCount: number;
  edgeCount: number;
  focus?: string;
}

export interface ExportResult {
  format: 'json' | 'dot' | 'mermaid';
  content: string;
}

export interface UpdateFileResult {
  updated: boolean;
  file: string;
  stats: ScanStats;
}

// ── 阅读路线（route）：从入口出发的**有序**阅读清单 ──
// 与 SubgraphResult 的本质区别：那个是无序集合，这个每一步都有先后。

/**
 * 同名定义候选。
 *
 * 没有 compile_commands.json 时，调用边是**按名字消解**的，所以只要项目里还有别的
 * 同名定义，这一步就可能停在错的那一个上。引擎把这些同名定义列出来，
 * 由用户决定该读哪个（`route` 的 `overrides` 参数就是干这个的）。
 */
export interface RouteCandidate {
  id: string;
  name: string;
  file: string;
  line: number;
  column: number;
  declaration: boolean;
  detail: string;
}

export interface RouteStep {
  /** 1-based 步号，也就是阅读顺序 */
  order: number;
  /** 父步骤的 order；0 表示起点 */
  parent: number;
  depth: number;
  /** 首次进入该文件 */
  newFile: boolean;
  /** 同名定义在项目里还有别的 → 按名字消解可能选错了那一个 */
  ambiguous: boolean;
  /** 其他同名定义（不含自己），已按（文件, 行号）排序；超过 20 个时被截断 */
  candidates?: RouteCandidate[];
  /** 其他同名定义的**总数**（未被截断的真实值） */
  candidateTotal: number;
  id: string;
  kind: NodeKind;
  name: string;
  file: string;
  line: number;
  column: number;
  module: string;
  detail: string;
  external: boolean;
  precision: Precision;
  /**
   * 函数体行数（含花括号那两行）；0 = 只有声明，或者根本不是函数。
   * 降噪判「小函数」用的就是它 —— 声明处没有花括号，所以声明只能是 0。
   */
  bodyLines: number;
  /**
   * 被降噪折叠掉的琐碎步骤名（纯转发 / 小函数）。
   * 折叠**不是静默删除**：名字挂到最近的那个保留祖先上，由 UI 如实展示。
   */
  skipped?: string[];
  /** 公开面：这一步的声明落在哪个公开头文件（`include/` 这类目录下）；缺失 = 不是公开接口 */
  apiHeader?: string;
  apiLine?: number;
}

/** 编辑器里「这个符号是什么」—— 供「从光标处开始读」用 */
export interface NodeAtResult {
  id: string;
  name: string;
  kind: NodeKind;
  file: string;
  line: number;
  column: number;
  external: boolean;
  declaration: boolean;
  detail: string;
}

/**
 * 起点候选（`entries`）。
 *
 * 库项目没有 main，「从哪读起」这个问题照样存在 —— 答案是它的**公开接口**。
 * 引擎只给候选与判据（是不是公开面、有多少调用者/下游），**不替用户挑**：
 * 路线的全部价值就是顺序，而顺序由起点决定 —— 挑错了后面整条都是错的。
 */
export interface EntryCandidate {
  id: string;
  name: string;
  kind: NodeKind;
  file: string;
  line: number;
  column: number;
  detail: string;
  /** main / WinMain / DllMain 这类程序入口 */
  mainLike: boolean;
  /** 声明或定义落在 include/ 这类公开目录里 */
  publicApi: boolean;
  /** 那个公开头文件的位置；空 = 不是公开接口 */
  apiHeader: string;
  apiLine: number;
  /** 项目内的调用者数量（只算 calls 入边） */
  callers: number;
  /** 项目内被它调用的函数数量（只算 calls 出边） */
  callees: number;
}

export interface EntriesResult {
  candidates: EntryCandidate[];
  /** 未截断的候选总数 */
  total: number;
  /** 找到程序入口了吗（有的话第一个候选就是它） */
  hasMain: boolean;
}

/**
 * 架构边界违规（`violations`）。
 *
 * 两条检查的共同点是**不需要启发式**：泄漏来自「公开面 vs 非公开面」的边，
 * 环来自强连通分量 —— 都能自己核对。刻意不做「按目录名猜层次」那种，
 * 它换个命名习惯就会满屏误报，而误报会让人直接关掉整个检查。
 */
export interface Violation {
  /** `public-api-leak`（公开头文件引用了内部实现）| `directory-cycle`（目录之间成环） */
  kind: string;
  /** 能跳到源码的位置 */
  fromFile: string;
  fromLine: number;
  /** 泄漏：被引用的那个非公开文件；目录环：空 */
  toFile: string;
  /** 目录环：环里的目录（已排序）；泄漏：空 */
  dirs?: string[];
  /** 目录环：环内参与的依赖边数 */
  edgeCount: number;
}

export interface ViolationsResult {
  violations: Violation[];
  /** 未截断的真实数量（列表可能被 maxItems 截断） */
  total: number;
}

export interface RouteResult {
  from: string;
  steps: RouteStep[];
  truncated: boolean;
  frontierNodes: number;
  frontierFiles: number;
  maxReachedDepth: number;
  /** 本次折叠掉的琐碎步骤数（关掉 skipTrivial 时为 0） */
  skippedCount: number;
}

/**
 * 「小函数」的函数体行数上限，默认 3。
 * **必须与 engine/src/route.hpp 的 RouteOptions::trivialBodyLines 保持一致** ——
 * 插件总是显式传这个值，免得同一个阈值在两个语言里各写一遍、各改一次。
 */
export const DEFAULT_TRIVIAL_BODY_LINES = 3;

export interface RouteOptions {
  from?: string;
  strategy?: 'bfs' | 'dfs';
  maxSteps?: number;
  maxDepth?: number;
  projectOnly?: boolean;
  groupByFile?: boolean;
  /**
   * 降噪：折叠「纯转发 / 小函数」（只调一处、且函数体不超过 trivialBodyLines 行）。
   * 起点永不被折叠。引擎默认 false（原样给出全部步骤），插件默认开启。
   */
  skipTrivial?: boolean;
  /** 判「小函数」的函数体行数上限，默认 3 */
  trivialBodyLines?: number;
  /**
   * 人工纠偏：`"<父节点 id>|<简单名>": "<改用的节点 id>"`。
   * 用节点 id 而不是步号做 key —— 步号会随纠偏本身变化，节点 id 不会。
   */
  overrides?: Record<string, string>;
}

export type Direction = 'both' | 'upstream' | 'downstream';

export interface ProgressParams {
  done: number;
  total: number;
  file: string;
}
