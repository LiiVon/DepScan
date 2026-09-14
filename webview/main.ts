// DepScan Webview 主程序：图 / 树 / 表格 三视图联动 + 导出。
import {
  ALL_EDGE_KINDS,
  ALL_NODE_KINDS,
  EDGE_COLORS,
  NODE_COLORS,
  NODE_RADIUS,
  clusterByModule,
  recomputeDegrees,
  type EdgeKind,
  type GraphData,
  type GraphEdge,
  type GraphNode,
  type NodeKind
} from '../src/graph/model';
import { ForceLayout } from './force';
import { GraphView } from './graph';
import type { HostToWebview, UiSettings, WebviewToHost } from './types';

interface VsCodeApi {
  postMessage(message: WebviewToHost): void;
  getState(): unknown;
  setState(state: unknown): void;
}

declare function acquireVsCodeApi(): VsCodeApi;

const vscode = acquireVsCodeApi();
const FORCE_NODE_LIMIT = 260;

const el = <T extends HTMLElement>(id: string): T => {
  const node = document.getElementById(id);
  if (!node) throw new Error(`missing element #${id}`);
  return node as T;
};

const I18N = JSON.parse(el('i18n').textContent ?? '{}') as Record<string, string>;

interface State {
  raw: GraphData;
  view: GraphData;
  settings: UiSettings;
  truncated: boolean;
  selectedId: string | undefined;
  search: string;
}

const state: State = {
  raw: { nodes: [], edges: [] },
  view: { nodes: [], edges: [] },
  settings: {
    depth: 2,
    direction: 'both',
    showExternal: false,
    cluster: false,
    clickToOpen: true,
    focusId: '',
    label: '',
    language: 'auto'
  },
  truncated: false,
  selectedId: undefined,
  search: ''
};

let canvasView: GraphView;

// ------------------------------ 初始化 ------------------------------

function init(): void {
  const canvas = el<HTMLCanvasElement>('graph-canvas');
  canvasView = new GraphView(canvas, {
    onClick: (node) => {
      if (!node) {
        state.selectedId = undefined;
        renderTree();
        renderTable();
        return;
      }
      selectNode(node.id, true);
      if (state.settings.clickToOpen && node.file) {
        vscode.postMessage({
          type: 'open',
          id: node.id,
          file: node.file,
          line: node.line,
          column: node.column
        });
      }
    },
    onDoubleClick: (node) => {
      vscode.postMessage({
        type: 'expand',
        id: node.id,
        depth: 1,
        direction: state.settings.direction
      });
    },
    onHover: (node) => {
      showDetails(node);
    }
  });

  bindToolbar();
  bindTabs();
  const refit = (): void => {
    canvasView.resize();
    if (!canvasView.userAdjustedView && state.view.nodes.length > 0) canvasView.fitToContent();
  };
  window.addEventListener('resize', refit);

  const observer = new ResizeObserver(refit);
  observer.observe(el('view-graph'));

  setLoading(I18N.loading ?? 'Loading…');
  vscode.postMessage({ type: 'ready' });
}

function bindToolbar(): void {
  el('btn-depth-minus').addEventListener('click', () => changeDepth(-1));
  el('btn-depth-plus').addEventListener('click', () => changeDepth(1));

  const direction = el<HTMLSelectElement>('sel-direction');
  direction.addEventListener('change', () => {
    state.settings.direction = direction.value as UiSettings['direction'];
    reload();
  });

  const depthInput = el<HTMLInputElement>('input-depth');
  depthInput.addEventListener('change', () => {
    const value = Math.max(1, Math.min(6, Number(depthInput.value) || 2));
    state.settings.depth = value;
    depthInput.value = String(value);
    el('depth-value').textContent = String(value);
    reload();
  });

  const external = el<HTMLInputElement>('chk-external');
  external.addEventListener('change', () => {
    state.settings.showExternal = external.checked;
    reload();
  });

  const cluster = el<HTMLInputElement>('chk-cluster');
  cluster.addEventListener('change', () => {
    state.settings.cluster = cluster.checked;
    renderGraph();
  });

  const clickOpen = el<HTMLInputElement>('chk-clickopen');
  clickOpen.addEventListener('change', () => {
    state.settings.clickToOpen = clickOpen.checked;
  });

  // 语言切换：工具栏里直接可切，不必再去侧边栏或设置页
  const language = el<HTMLSelectElement>('sel-language');
  language.addEventListener('change', () => {
    vscode.postMessage({ type: 'setLanguage', language: language.value as UiSettings['language'] });
  });

  el('btn-fit').addEventListener('click', () => canvasView.resetView());
  el('btn-refresh').addEventListener('click', () => reload());
  el('btn-arch').addEventListener('click', () => vscode.postMessage({ type: 'architecture' }));

  el('btn-export-png').addEventListener('click', () => {
    const off = canvasView.renderToCanvas(2);
    vscode.postMessage({
      type: 'exportImage',
      format: 'png',
      data: off.toDataURL('image/png'),
      suggestedName: 'depscan-graph.png'
    });
  });
  el('btn-export-svg').addEventListener('click', () => {
    vscode.postMessage({
      type: 'exportImage',
      format: 'svg',
      data: canvasView.toSvg(),
      suggestedName: 'depscan-graph.svg'
    });
  });
  el('btn-export-json').addEventListener('click', () => vscode.postMessage({ type: 'exportData', format: 'json' }));
  el('btn-export-dot').addEventListener('click', () => vscode.postMessage({ type: 'exportData', format: 'dot' }));
  el('btn-export-mermaid').addEventListener('click', () =>
    vscode.postMessage({ type: 'exportData', format: 'mermaid' })
  );

  const search = el<HTMLInputElement>('search');
  search.addEventListener('input', () => {
    state.search = search.value.trim().toLowerCase();
    renderTable();
    renderTree();
    if (state.search) {
      const hit = state.view.nodes.find((n) => n.name.toLowerCase().includes(state.search));
      if (hit) selectNode(hit.id, false);
    }
  });
}

function bindTabs(): void {
  const tabs: Array<['graph' | 'tree' | 'table', string]> = [
    ['graph', 'tab-graph'],
    ['tree', 'tab-tree'],
    ['table', 'tab-table']
  ];
  for (const [name, id] of tabs) {
    el(id).addEventListener('click', () => {
      for (const [, other] of tabs) el(other).classList.toggle('active', other === id);
      el('view-graph').classList.toggle('hidden', name !== 'graph');
      el('view-tree').classList.toggle('hidden', name !== 'tree');
      el('view-table').classList.toggle('hidden', name !== 'table');
      if (name === 'graph') canvasView.resize();
    });
  }
}

function changeDepth(delta: number): void {
  const next = Math.max(1, Math.min(6, state.settings.depth + delta));
  if (next === state.settings.depth) return;
  state.settings.depth = next;
  el<HTMLInputElement>('input-depth').value = String(next);
  el('depth-value').textContent = String(next);
  reload();
}

function reload(): void {
  setLoading(I18N.loading ?? 'Loading…');
  vscode.postMessage({
    type: 'reload',
    depth: state.settings.depth,
    direction: state.settings.direction,
    showExternal: state.settings.showExternal
  });
}

// ------------------------------ 渲染 ------------------------------

function setLoading(message: string | undefined): void {
  const overlay = el('overlay');
  if (message) {
    overlay.textContent = message;
    overlay.classList.remove('hidden');
  } else {
    overlay.classList.add('hidden');
  }
}

function toast(message: string): void {
  const box = el('toast');
  box.textContent = message;
  box.classList.remove('hidden');
  window.setTimeout(() => box.classList.add('hidden'), 2600);
}

function renderGraph(): void {
  let graph = state.raw;
  if (!state.settings.showExternal) {
    graph = filterExternal(graph);
  }
  // 超过上限才强制聚类；勾选框只影响是否启用（避免小图被折成无意义的目录块）
  if (state.settings.cluster || graph.nodes.length > 400) {
    graph = clusterByModule(graph);
  } else {
    recomputeDegrees(graph);
  }
  state.view = graph;

  // 先确定画布尺寸再做布局：早期版本反过来，画布尺寸为 0 时
  // 会把所有节点初始化到同一点，斥力直接把布局炸飞。
  canvasView.resize();
  const size = canvasView.viewSize;
  const width = size.width > 1 ? size.width : 900;
  const height = size.height > 1 ? size.height : 600;
  const simNodes = graph.nodes.map((n) => ({ id: n.id, radius: NODE_RADIUS[n.kind as NodeKind] ?? 8 }));

  if (graph.nodes.length <= FORCE_NODE_LIMIT) {
    const force = new ForceLayout(width, height);
    force.setData(simNodes, graph.edges.map((e) => ({ source: e.from, target: e.to, kind: e.kind })));
    force.run(320);
    canvasView.setData(graph, force.nodes);
  } else {
    canvasView.setData(graph, ForceLayout.gridLayout(width, height, simNodes));
  }
  canvasView.fitToContent();

  updateLegend();
  updateStatus();
  renderTree();
  renderTable();
}

function filterExternal(graph: GraphData): GraphData {
  const keep = new Set(graph.nodes.filter((n) => !n.external).map((n) => n.id));
  return {
    nodes: graph.nodes.filter((n) => keep.has(n.id)),
    edges: graph.edges.filter((e) => keep.has(e.from) && keep.has(e.to))
  };
}

function selectNode(id: string, center: boolean): void {
  state.selectedId = id;
  canvasView.select(id);
  if (center) {
    const pos = canvasView.positionOf(id);
    if (pos) {
      const { width, height } = canvasView.viewSize;
      canvasView.zoomBy(1, { x: width / 2, y: height / 2 });
      void pos;
    }
  }
  const node = state.view.nodes.find((n) => n.id === id);
  showDetails(node);
  markSelection();
}

function showDetails(node: GraphNode | undefined): void {
  const box = el('details');
  if (!node) {
    box.innerHTML = `<div class="muted">${escapeHtml(I18N.hint ?? '')}</div>`;
    return;
  }
  const kind = I18N[`kind.${node.kind}`] ?? node.kind;
  const precision = node.precision === 'exact' ? I18N['precision.exact'] : I18N['precision.approx'];
  const rows: string[] = [];
  rows.push(`<div class="detail-title"><span class="dot" style="background:${NODE_COLORS[node.kind as NodeKind] ?? '#999'}"></span>${escapeHtml(node.name)}</div>`);
  rows.push(`<div class="detail-grid">`);
  rows.push(`<span class="k">${I18N['table.kind'] ?? 'Kind'}</span><span>${escapeHtml(kind)}</span>`);
  if (node.file) rows.push(`<span class="k">${I18N['table.file'] ?? 'File'}</span><span>${escapeHtml(node.file)}:${node.line}</span>`);
  rows.push(`<span class="k">${I18N['table.precision'] ?? 'Precision'}</span><span>${escapeHtml(precision)}</span>`);
  rows.push(`<span class="k">${I18N['table.outDeps'] ?? 'Out'}</span><span>${node.outDegree}</span>`);
  rows.push(`<span class="k">${I18N['table.inDeps'] ?? 'In'}</span><span>${node.inDegree}</span>`);
  rows.push(`</div>`);
  if (node.detail) rows.push(`<div class="detail-extra">${escapeHtml(node.detail)}</div>`);
  box.innerHTML = rows.join('');
}

function updateLegend(): void {
  const legend = el('legend');
  const nodeKinds = ALL_NODE_KINDS.filter((k) => state.view.nodes.some((n) => n.kind === k));
  const edgeKinds = ALL_EDGE_KINDS.filter((k) => state.view.edges.some((e) => e.kind === k));
  const parts: string[] = [];
  for (const k of nodeKinds) {
    parts.push(
      `<span class="legend-item"><span class="dot" style="background:${NODE_COLORS[k]}"></span>${escapeHtml(I18N[`kind.${k}`] ?? k)}</span>`
    );
  }
  for (const k of edgeKinds) {
    parts.push(
      `<span class="legend-item"><span class="line" style="background:${EDGE_COLORS[k]}"></span>${escapeHtml(I18N[`edge.${k}`] ?? k)}</span>`
    );
  }
  legend.innerHTML = parts.join('');
}

function updateStatus(): void {
  const stats = state.settings.stats;
  const bits: string[] = [];
  const line = I18N['graph.statsLine'] ?? '{n} nodes · {e} edges';
  bits.push(line.replace('{n}', String(state.view.nodes.length)).replace('{e}', String(state.view.edges.length)));
  if (stats) {
    bits.push(
      stats.precision === 'exact'
        ? I18N['precision.exact'] ?? 'exact'
        : I18N['precision.approx'] ?? 'approx'
    );
  }
  if (state.truncated) {
    bits.push((I18N['graph.truncated'] ?? '').replace('{n}', String(state.view.nodes.length)));
  }
  el('status').textContent = bits.filter((b) => b.length > 0).join('   ·   ');
}

// ------------------------------ 树视图 ------------------------------

interface TreeNode {
  node: GraphNode;
  edgeKind?: EdgeKind;
  children: TreeNode[];
}

function buildTree(): TreeNode[] {
  const byId = new Map(state.view.nodes.map((n) => [n.id, n]));
  const focus = byId.get(state.settings.focusId);
  if (!focus) return [];
  const out = new Map<string, GraphEdge[]>();
  const inc = new Map<string, GraphEdge[]>();
  for (const e of state.view.edges) {
    if (!out.has(e.from)) out.set(e.from, []);
    if (!inc.has(e.to)) inc.set(e.to, []);
    out.get(e.from)!.push(e);
    inc.get(e.to)!.push(e);
  }

  const visited = new Set<string>([focus.id]);
  const build = (node: GraphNode, depth: number): TreeNode => {
    const tree: TreeNode = { node, children: [] };
    if (depth >= 3) return tree;
    const edges: GraphEdge[] = [];
    if (state.settings.direction !== 'upstream') edges.push(...(out.get(node.id) ?? []));
    if (state.settings.direction !== 'downstream') edges.push(...(inc.get(node.id) ?? []));
    for (const e of edges) {
      const childId = e.from === node.id ? e.to : e.from;
      if (visited.has(childId)) continue;
      const child = byId.get(childId);
      if (!child) continue;
      visited.add(childId);
      const sub = build(child, depth + 1);
      sub.edgeKind = e.kind;
      tree.children.push(sub);
    }
    return tree;
  };
  return [build(focus, 0)];
}

function renderTree(): void {
  const root = el('tree-root');
  const trees = buildTree();
  if (trees.length === 0) {
    root.innerHTML = `<div class="muted">${escapeHtml(I18N.empty ?? '')}</div>`;
    return;
  }
  const filter = state.search;
  const html: string[] = ['<ul class="tree">'];
  const walk = (t: TreeNode, depth: number): void => {
    if (filter && !t.node.name.toLowerCase().includes(filter) && !hasMatchingChild(t, filter)) return;
    const kind = I18N[`kind.${t.node.kind}`] ?? t.node.kind;
    const edgeBadge = t.edgeKind
      ? `<span class="edge-badge" style="background:${EDGE_COLORS[t.edgeKind]}">${escapeHtml(I18N[`edge.${t.edgeKind}`] ?? t.edgeKind)}</span>`
      : '';
    html.push(
      `<li><div class="tree-row" data-id="${escapeHtml(t.node.id)}" style="padding-left:${depth * 14 + 6}px">` +
        `<span class="dot" style="background:${NODE_COLORS[t.node.kind as NodeKind] ?? '#999'}"></span>` +
        `<span class="tree-name" title="${escapeHtml(t.node.name)}\n${escapeHtml(kind)}">${escapeHtml(t.node.name)}</span>` +
        edgeBadge +
        (t.node.external ? '<span class="badge">ext</span>' : '') +
        `</div>`
    );
    if (t.children.length) {
      html.push('<ul>');
      for (const c of t.children) walk(c, depth + 1);
      html.push('</ul>');
    }
    html.push('</li>');
  };
  for (const t of trees) walk(t, 0);
  html.push('</ul>');
  root.innerHTML = html.join('');

  for (const row of Array.from(root.querySelectorAll<HTMLElement>('.tree-row'))) {
    row.addEventListener('click', () => {
      const id = row.dataset.id;
      if (!id) return;
      selectNode(id, true);
      const node = state.view.nodes.find((n) => n.id === id);
      if (node?.file) {
        vscode.postMessage({ type: 'open', id, file: node.file, line: node.line, column: node.column });
      }
    });
    row.addEventListener('dblclick', () => {
      const id = row.dataset.id;
      if (id) vscode.postMessage({ type: 'expand', id, depth: 1, direction: state.settings.direction });
    });
  }
  markSelection();
}

function hasMatchingChild(t: TreeNode, filter: string): boolean {
  return t.children.some(
    (c) => c.node.name.toLowerCase().includes(filter) || hasMatchingChild(c, filter)
  );
}

// ------------------------------ 表格视图 ------------------------------

function renderTable(): void {
  const body = el('table-body');
  const filter = state.search;
  const rows = [...state.view.nodes]
    .filter((n) => !filter || n.name.toLowerCase().includes(filter) || n.file.toLowerCase().includes(filter))
    .sort((a, b) => b.inDegree + b.outDegree - (a.inDegree + a.outDegree));
  body.innerHTML = rows
    .map((n) => {
      const kind = I18N[`kind.${n.kind}`] ?? n.kind;
      const preview =
        n.precision === 'exact'
          ? `<span class="pill exact">${escapeHtml(I18N['precision.exact'] ?? 'exact')}</span>`
          : `<span class="pill approx">${escapeHtml(I18N['precision.approx'] ?? 'approx')}</span>`;
      return (
        `<tr data-id="${escapeHtml(n.id)}">` +
        `<td><span class="dot" style="background:${NODE_COLORS[n.kind as NodeKind] ?? '#999'}"></span>${escapeHtml(n.name)}</td>` +
        `<td>${escapeHtml(kind)}</td>` +
        `<td class="num">${n.outDegree}</td>` +
        `<td class="num">${n.inDegree}</td>` +
        `<td class="path">${escapeHtml(n.file)}${n.line ? `:${n.line}` : ''}</td>` +
        `<td>${preview}</td>` +
        `</tr>`
      );
    })
    .join('');

  for (const row of Array.from(body.querySelectorAll<HTMLTableRowElement>('tr'))) {
    row.addEventListener('click', () => {
      const id = row.dataset.id;
      if (!id) return;
      selectNode(id, true);
      const node = state.view.nodes.find((n) => n.id === id);
      if (node?.file) {
        vscode.postMessage({ type: 'open', id, file: node.file, line: node.line, column: node.column });
      }
    });
  }
  markSelection();
}

function markSelection(): void {
  const selected = state.selectedId;
  for (const row of Array.from(document.querySelectorAll<HTMLElement>('.tree-row, tbody tr'))) {
    row.classList.toggle('selected', !!selected && row.dataset.id === selected);
  }
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

// ------------------------------ 与宿主通信 ------------------------------

window.addEventListener('message', (event: MessageEvent<HostToWebview>) => {
  const msg = event.data;
  switch (msg.type) {
    case 'render':
      state.raw = msg.graph;
      state.settings = { ...msg.settings };
      state.truncated = msg.truncated;
      state.selectedId = msg.settings.focusId;
      el<HTMLInputElement>('input-depth').value = String(msg.settings.depth);
      el('depth-value').textContent = String(msg.settings.depth);
      el<HTMLSelectElement>('sel-direction').value = msg.settings.direction;
      el<HTMLSelectElement>('sel-language').value = msg.settings.language ?? 'auto';
      el<HTMLInputElement>('chk-external').checked = msg.settings.showExternal;
      el<HTMLInputElement>('chk-cluster').checked = msg.settings.cluster;
      el('focus-label').textContent = msg.settings.label;
      document.title = msg.settings.label;
      setLoading(undefined);
      renderGraph();
      if (state.raw.nodes.length === 0) toast(I18N.empty ?? 'empty');
      break;
    case 'merge':
      state.raw = msg.graph;
      state.settings.stats = msg.settings.stats ?? state.settings.stats;
      renderGraph();
      if (state.selectedId) selectNode(state.selectedId, false);
      break;
    case 'select':
      selectNode(msg.id, true);
      break;
    case 'loading':
      setLoading(msg.message);
      break;
    case 'error':
      setLoading(undefined);
      toast(msg.message);
      break;
    case 'toast':
      toast(msg.message);
      break;
  }
});

// 启动
init();

export {};
