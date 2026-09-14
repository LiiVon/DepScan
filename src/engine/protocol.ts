// 引擎通信协议（与 engine/src/rpc.cpp 一一对应）
import type { GraphData, ScanStats } from '../graph/model';

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

export type Direction = 'both' | 'upstream' | 'downstream';

export interface ProgressParams {
  done: number;
  total: number;
  file: string;
}
