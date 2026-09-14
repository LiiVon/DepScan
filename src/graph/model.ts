// 依赖图数据模型 —— 引擎 / 插件 / Webview 三端共享的唯一真相来源。
// 字段名与 engine/include/depscan/types.hpp 严格对应，改动必须同步全链。

export type NodeKind =
  | 'file'
  | 'function'
  | 'class'
  | 'enum'
  | 'variable'
  | 'macro'
  | 'target'
  | 'unknown';

export type EdgeKind = 'includes' | 'calls' | 'inherits' | 'uses' | 'refs' | 'links';

export type Precision = 'exact' | 'approx';

export interface GraphNode {
  id: string;
  kind: NodeKind;
  name: string;
  file: string;
  line: number;
  column: number;
  module: string;
  detail: string;
  precision: Precision;
  external: boolean;
  declaration: boolean;
  inDegree: number;
  outDegree: number;
}

export interface GraphEdge {
  from: string;
  to: string;
  kind: EdgeKind;
  precision: Precision;
  file: string;
  line: number;
}

export interface GraphData {
  nodes: GraphNode[];
  edges: GraphEdge[];
}

export interface ScanStats {
  root: string;
  engineVersion: string;
  fileCount: number;
  symbolCount: number;
  edgeCount: number;
  unresolvedRefs: number;
  skippedFiles: number;
  exactNodes: number;
  approxNodes: number;
  exactIncludeEdges: number;
  approxIncludeEdges: number;
  compileCommandsFound: boolean;
  compileCommandsPath: string;
  compileCommandEntries: number;
  libclangAvailable: boolean;
  elapsedMs: number;
  precision: Precision;
  nodeKindCounts: Record<string, number>;
  edgeKindCounts: Record<string, number>;
  warnings: string[];
}

export const ALL_NODE_KINDS: NodeKind[] = [
  'file',
  'function',
  'class',
  'enum',
  'variable',
  'macro',
  'target'
];

export const ALL_EDGE_KINDS: EdgeKind[] = ['includes', 'calls', 'inherits', 'uses', 'refs', 'links'];

// 节点配色：与 UI 图例一一对应（外部节点统一灰色虚线边框）
export const NODE_COLORS: Record<NodeKind, string> = {
  file: '#4a9eff',
  function: '#38c172',
  class: '#f6a623',
  enum: '#b07cf5',
  variable: '#e05c8a',
  macro: '#7f8fa6',
  target: '#00b8a9',
  unknown: '#95a5a6'
};

export const EDGE_COLORS: Record<EdgeKind, string> = {
  includes: '#4a9eff',
  calls: '#38c172',
  inherits: '#f6a623',
  uses: '#b07cf5',
  refs: '#7f8fa6',
  links: '#00b8a9'
};

export const NODE_RADIUS: Record<NodeKind, number> = {
  file: 13,
  function: 9,
  class: 11,
  enum: 9,
  variable: 7,
  macro: 7,
  target: 13,
  unknown: 7
};

export function nodeKindOf(node: GraphNode): NodeKind {
  return node.kind ?? 'unknown';
}

/** 从 file:<rel> / func:<qname> 这类 id 中解析出负载部分 */
export function idPayload(id: string): string {
  const idx = id.indexOf(':');
  return idx < 0 ? id : id.slice(idx + 1);
}

export function makeFileId(relPath: string): string {
  return `file:${relPath}`;
}

export function fileNameOf(node: GraphNode): string {
  if (node.name) return node.name;
  const payload = idPayload(node.id);
  const slash = Math.max(payload.lastIndexOf('/'), payload.lastIndexOf('\\'));
  return slash < 0 ? payload : payload.slice(slash + 1);
}

export function edgeKey(e: GraphEdge): string {
  return `${e.from}\u0001${e.to}\u0001${e.kind}`;
}

/** 按目录聚类（LOD 第 2 层）：把 file: 节点折叠成目录节点 */
export function clusterByModule(graph: GraphData): GraphData {
  const dirId = (m: string) => `dir:${m}`;
  const nodes = new Map<string, GraphNode>();
  const remap = new Map<string, string>();

  for (const n of graph.nodes) {
    if (n.external) {
      nodes.set(n.id, n);
      remap.set(n.id, n.id);
      continue;
    }
    const group = n.module && n.module !== '.' ? n.module : (n.file.split('/')[0] || '.');
    const id = dirId(group);
    remap.set(n.id, id);
    const existing = nodes.get(id);
    if (existing) {
      existing.detail = `${Number.parseInt(existing.detail, 10) + 1} 个节点`;
    } else {
      nodes.set(id, {
        id,
        kind: n.kind === 'target' ? 'target' : 'file',
        name: group,
        file: '',
        line: 0,
        column: 0,
        module: group,
        detail: '1 个节点',
        precision: n.precision,
        external: false,
        declaration: false,
        inDegree: 0,
        outDegree: 0
      });
    }
  }

  const edges = new Map<string, GraphEdge>();
  for (const e of graph.edges) {
    const from = remap.get(e.from);
    const to = remap.get(e.to);
    if (!from || !to || from === to) continue;
    const key = `${from}\u0001${to}\u0001${e.kind}`;
    if (!edges.has(key)) edges.set(key, { ...e, from, to });
  }

  const out: GraphData = { nodes: [...nodes.values()], edges: [...edges.values()] };
  recomputeDegrees(out);
  return out;
}

export function recomputeDegrees(graph: GraphData): void {
  const byId = new Map(graph.nodes.map((n) => [n.id, n]));
  for (const n of graph.nodes) {
    n.inDegree = 0;
    n.outDegree = 0;
  }
  for (const e of graph.edges) {
    const a = byId.get(e.from);
    const b = byId.get(e.to);
    if (a) a.outDegree += 1;
    if (b) b.inDegree += 1;
  }
}
