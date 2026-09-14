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
export interface RouteStep {
  /** 1-based 步号，也就是阅读顺序 */
  order: number;
  /** 父步骤的 order；0 表示起点 */
  parent: number;
  depth: number;
  /** 首次进入该文件 */
  newFile: boolean;
  /** 有多个同名候选 —— 近似精度下按名字消解，这一步可能是错边 */
  ambiguous: boolean;
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
}

export interface RouteResult {
  from: string;
  steps: RouteStep[];
  truncated: boolean;
  frontierNodes: number;
  frontierFiles: number;
  maxReachedDepth: number;
}

export interface RouteOptions {
  from?: string;
  strategy?: 'bfs' | 'dfs';
  maxSteps?: number;
  maxDepth?: number;
  projectOnly?: boolean;
  groupByFile?: boolean;
}

export type Direction = 'both' | 'upstream' | 'downstream';

export interface ProgressParams {
  done: number;
  total: number;
  file: string;
}
