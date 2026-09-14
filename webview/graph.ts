import {
  EDGE_COLORS,
  NODE_COLORS,
  NODE_RADIUS,
  type EdgeKind,
  type GraphData,
  type GraphNode,
  type NodeKind
} from '../src/graph/model';
import type { SimNode } from './force';

interface Vec {
  x: number;
  y: number;
}

export interface GraphViewCallbacks {
  onClick(node: GraphNode | undefined, event: { ctrl: boolean }): void;
  onDoubleClick(node: GraphNode): void;
  onHover(node: GraphNode | undefined): void;
}

const LABEL_MIN_SCALE = 0.75;

export class GraphView {
  private readonly ctx: CanvasRenderingContext2D;
  private graph: GraphData = { nodes: [], edges: [] };
  private positions = new Map<string, SimNode>();
  private adjacency = new Map<string, Set<string>>();
  private byId = new Map<string, GraphNode>();

  private scale = 1;
  private tx = 0;
  private ty = 0;

  private selectedId: string | undefined;
  private hoveredId: string | undefined;

  private dragging: SimNode | undefined;
  private panning = false;
  private panStart: Vec = { x: 0, y: 0 };
  private movedSinceDown = false;
  private downPos: Vec = { x: 0, y: 0 };
  private rafHandle = 0;
  private needsDraw = false;

  /** 用户是否手动缩放/平移过（用于决定窗口 resize 后要不要重新自适应） */
  userAdjustedView = false;

  constructor(
    private readonly canvas: HTMLCanvasElement,
    private readonly callbacks: GraphViewCallbacks
  ) {
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('2D context unavailable');
    this.ctx = ctx;
    this.bindEvents();
  }

  // ------------------------------ 数据 ------------------------------

  setData(graph: GraphData, positions: SimNode[]): void {
    this.graph = graph;
    this.positions = new Map(positions.map((p) => [p.id, p]));
    this.byId = new Map(graph.nodes.map((n) => [n.id, n]));
    this.adjacency = new Map();
    for (const e of graph.edges) {
      if (!this.adjacency.has(e.from)) this.adjacency.set(e.from, new Set());
      if (!this.adjacency.has(e.to)) this.adjacency.set(e.to, new Set());
      this.adjacency.get(e.from)!.add(e.to);
      this.adjacency.get(e.to)!.add(e.from);
    }
    if (this.selectedId && !this.byId.has(this.selectedId)) this.selectedId = undefined;
    this.requestDraw();
  }

  /** 增量合并：保留已有节点位置，只新增/更新变化的节点与边 */
  mergeData(graph: GraphData, positions: SimNode[]): void {
    for (const p of positions) {
      if (!this.positions.has(p.id)) this.positions.set(p.id, p);
    }
    this.setData(graph, [...this.positions.values()]);
  }

  get data(): GraphData {
    return this.graph;
  }

  get selection(): string | undefined {
    return this.selectedId;
  }

  select(id: string | undefined): void {
    this.selectedId = id;
    this.requestDraw();
  }

  positionOf(id: string): SimNode | undefined {
    return this.positions.get(id);
  }

  setPositions(positions: SimNode[]): void {
    for (const p of positions) this.positions.set(p.id, p);
    this.requestDraw();
  }

  // ------------------------------ 视图变换 ------------------------------

  resize(): void {
    const dpr = window.devicePixelRatio || 1;
    const rect = this.canvas.getBoundingClientRect();
    this.canvas.width = Math.max(1, Math.floor(rect.width * dpr));
    this.canvas.height = Math.max(1, Math.floor(rect.height * dpr));
    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    this.requestDraw();
  }

  get viewSize(): { width: number; height: number } {
    const rect = this.canvas.getBoundingClientRect();
    return { width: rect.width, height: rect.height };
  }

  fitToContent(margin = 70): void {
    if (this.graph.nodes.length === 0) return;
    const { width, height } = this.viewSize;
    if (!(width > 1) || !(height > 1)) return;

    const b = this.contentBounds(0);
    // 把节点半径与一点留白计入内容尺寸
    const contentW = Math.max(1, b.maxX - b.minX) + 70;
    const contentH = Math.max(1, b.maxY - b.minY) + 70;
    this.scale = Math.min((width - margin) / contentW, (height - margin) / contentH, 2.5);
    this.scale = Math.max(this.scale, 0.1);
    this.tx = width / 2 - ((b.minX + b.maxX) / 2) * this.scale;
    this.ty = height / 2 - ((b.minY + b.maxY) / 2) * this.scale;
    this.userAdjustedView = false;
    this.requestDraw();
  }

  zoomBy(factor: number, anchor?: Vec): void {
    const { width, height } = this.viewSize;
    const a = anchor ?? { x: width / 2, y: height / 2 };
    const worldBefore = this.screenToWorld(a.x, a.y);
    this.scale = Math.min(6, Math.max(0.05, this.scale * factor));
    const worldAfter = this.screenToWorld(a.x, a.y);
    this.tx += (worldAfter.x - worldBefore.x) * this.scale;
    this.ty += (worldAfter.y - worldBefore.y) * this.scale;
    this.requestDraw();
  }

  resetView(): void {
    this.scale = 1;
    this.tx = 0;
    this.ty = 0;
    this.fitToContent();
  }

  private screenToWorld(x: number, y: number): Vec {
    return { x: (x - this.tx) / this.scale, y: (y - this.ty) / this.scale };
  }

  private hitTest(x: number, y: number): SimNode | undefined {
    const world = this.screenToWorld(x, y);
    let best: SimNode | undefined;
    let bestDist = Infinity;
    for (const node of this.positions.values()) {
      const d = Math.hypot(node.x - world.x, node.y - world.y);
      const limit = node.radius + 4 / this.scale;
      if (d <= limit && d < bestDist) {
        bestDist = d;
        best = node;
      }
    }
    return best;
  }

  // ------------------------------ 事件 ------------------------------

  private bindEvents(): void {
    const canvas = this.canvas;

    canvas.addEventListener(
      'wheel',
      (ev) => {
        ev.preventDefault();
        this.userAdjustedView = true;
        const rect = canvas.getBoundingClientRect();
        this.zoomBy(ev.deltaY < 0 ? 1.12 : 1 / 1.12, { x: ev.clientX - rect.left, y: ev.clientY - rect.top });
      },
      { passive: false }
    );

    canvas.addEventListener('pointerdown', (ev) => {
      canvas.setPointerCapture(ev.pointerId);
      this.userAdjustedView = true;
      const rect = canvas.getBoundingClientRect();
      const x = ev.clientX - rect.left;
      const y = ev.clientY - rect.top;
      this.movedSinceDown = false;
      this.downPos = { x, y };
      const hit = this.hitTest(x, y);
      if (hit) {
        this.dragging = hit;
        hit.pinned = true;
      } else {
        this.panning = true;
        this.panStart = { x: x - this.tx, y: y - this.ty };
      }
    });

    canvas.addEventListener('pointermove', (ev) => {
      const rect = canvas.getBoundingClientRect();
      const x = ev.clientX - rect.left;
      const y = ev.clientY - rect.top;
      if (Math.hypot(x - this.downPos.x, y - this.downPos.y) > 4) this.movedSinceDown = true;

      if (this.dragging) {
        const world = this.screenToWorld(x, y);
        this.dragging.x = world.x;
        this.dragging.y = world.y;
        this.dragging.vx = 0;
        this.dragging.vy = 0;
        this.requestDraw();
        return;
      }
      if (this.panning) {
        this.tx = x - this.panStart.x;
        this.ty = y - this.panStart.y;
        this.requestDraw();
        return;
      }
      const hit = this.hitTest(x, y);
      const id = hit?.id;
      if (id !== this.hoveredId) {
        this.hoveredId = id;
        canvas.style.cursor = hit ? 'pointer' : 'default';
        this.callbacks.onHover(id ? this.byId.get(id) : undefined);
        this.requestDraw();
      }
    });

    const finishPointer = (ev: PointerEvent) => {
      const wasDragging = this.dragging;
      const moved = this.movedSinceDown;
      this.dragging = undefined;
      this.panning = false;
      if (wasDragging) {
        if (!moved) {
          this.selectedId = wasDragging.id;
          this.callbacks.onClick(this.byId.get(wasDragging.id), { ctrl: ev.ctrlKey || ev.metaKey });
        }
        wasDragging.pinned = false;
      } else if (!moved) {
        this.selectedId = undefined;
        this.callbacks.onClick(undefined, { ctrl: ev.ctrlKey || ev.metaKey });
      }
      this.requestDraw();
    };
    canvas.addEventListener('pointerup', finishPointer);
    canvas.addEventListener('pointercancel', finishPointer);

    canvas.addEventListener('dblclick', (ev) => {
      const rect = canvas.getBoundingClientRect();
      const hit = this.hitTest(ev.clientX - rect.left, ev.clientY - rect.top);
      if (hit) {
        const node = this.byId.get(hit.id);
        if (node) this.callbacks.onDoubleClick(node);
      }
    });

    canvas.addEventListener('pointerleave', () => {
      if (this.hoveredId) {
        this.hoveredId = undefined;
        this.callbacks.onHover(undefined);
        this.requestDraw();
      }
    });
  }

  // ------------------------------ 绘制 ------------------------------

  requestDraw(): void {
    this.needsDraw = true;
    if (this.rafHandle) return;
    this.rafHandle = requestAnimationFrame(() => {
      this.rafHandle = 0;
      if (this.needsDraw) {
        this.needsDraw = false;
        this.draw();
      }
    });
  }

  private relatedTo(id: string | undefined): Set<string> | undefined {
    if (!id) return undefined;
    const set = new Set<string>([id]);
    for (const n of this.adjacency.get(id) ?? []) set.add(n);
    return set;
  }

  draw(): void {
    const { width, height } = this.viewSize;
    const ctx = this.ctx;
    ctx.save();
    ctx.clearRect(0, 0, width, height);
    ctx.translate(this.tx, this.ty);
    ctx.scale(this.scale, this.scale);

    const related = this.relatedTo(this.selectedId ?? this.hoveredId);
    const focus = this.selectedId ?? this.hoveredId;

    // 视口裁剪范围（世界坐标）
    const viewMinX = -this.tx / this.scale - 60;
    const viewMinY = -this.ty / this.scale - 60;
    const viewMaxX = (width - this.tx) / this.scale + 60;
    const viewMaxY = (height - this.ty) / this.scale + 60;

    const nodeById = this.byId;
    const pos = this.positions;

    // 边
    ctx.lineWidth = 1 / Math.max(0.6, Math.min(1.6, this.scale));
    for (const e of this.graph.edges) {
      const a = pos.get(e.from);
      const b = pos.get(e.to);
      if (!a || !b) continue;
      if (
        (a.x < viewMinX && b.x < viewMinX) ||
        (a.y < viewMinY && b.y < viewMinY) ||
        (a.x > viewMaxX && b.x > viewMaxX) ||
        (a.y > viewMaxY && b.y > viewMaxY)
      ) {
        continue;
      }
      const active = !focus || (related?.has(e.from) && related?.has(e.to));
      ctx.globalAlpha = focus ? (active ? 0.95 : 0.12) : 0.5;
      ctx.strokeStyle = EDGE_COLORS[e.kind as EdgeKind] ?? '#888';
      if (e.precision === 'approx') ctx.setLineDash([4, 3]);
      else ctx.setLineDash([]);

      ctx.beginPath();
      ctx.moveTo(a.x, a.y);
      ctx.lineTo(b.x, b.y);
      ctx.stroke();
      ctx.setLineDash([]);

      if (this.scale > 0.45) this.drawArrow(a, b, ctx, EDGE_COLORS[e.kind as EdgeKind] ?? '#888', nodeById.get(e.to));
    }

    // 节点
    for (const n of this.graph.nodes) {
      const p = pos.get(n.id);
      if (!p) continue;
      if (p.x < viewMinX || p.y < viewMinY || p.x > viewMaxX || p.y > viewMaxY) continue;
      const isFocus = n.id === focus;
      const active = !focus || related?.has(n.id);
      const color = n.external ? '#6b7280' : NODE_COLORS[n.kind as NodeKind] ?? '#999';

      ctx.globalAlpha = active ? 1 : 0.18;
      ctx.beginPath();
      ctx.arc(p.x, p.y, p.radius, 0, Math.PI * 2);
      ctx.fillStyle = color;
      ctx.fill();
      ctx.lineWidth = isFocus ? 3 / this.scale : 1.4 / this.scale;
      ctx.strokeStyle = isFocus ? '#ffffff' : n.external ? '#94a3b8' : 'rgba(0,0,0,0.35)';
      if (n.external) ctx.setLineDash([3, 2]);
      ctx.stroke();
      ctx.setLineDash([]);
    }

    // 标签（LOD：缩放过小时不画标签，保证大图流畅）
    const showLabels = this.scale >= LABEL_MIN_SCALE;
    ctx.globalAlpha = 1;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'top';
    for (const n of this.graph.nodes) {
      const p = pos.get(n.id);
      if (!p) continue;
      if (p.x < viewMinX || p.y < viewMinY || p.x > viewMaxX || p.y > viewMaxY) continue;
      const isFocus = n.id === focus;
      const important = isFocus || (related?.has(n.id) && p.radius >= 9);
      if (!showLabels && !important) continue;
      const label = truncate(n.name, 22);
      ctx.globalAlpha = isFocus ? 1 : related?.has(n.id) ? 0.95 : 0.25;
      const fontSize = Math.max(9, Math.min(13, 11 / this.scale));
      ctx.font = `${isFocus ? '600' : '400'} ${fontSize}px var(--vscode-font-family, sans-serif)`;
      const textWidth = ctx.measureText(label).width;
      const bx = p.x - textWidth / 2 - 3;
      const by = p.y + p.radius + 3;
      ctx.fillStyle = 'rgba(0,0,0,0.45)';
      ctx.fillRect(bx, by, textWidth + 6, fontSize + 4);
      ctx.fillStyle = '#f5f5f5';
      ctx.fillText(label, p.x, by + 2);
    }

    ctx.restore();
  }

  private drawArrow(
    a: SimNode,
    b: SimNode,
    ctx: CanvasRenderingContext2D,
    color: string,
    targetNode: GraphNode | undefined
  ): void {
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const dist = Math.hypot(dx, dy) || 1;
    const ux = dx / dist;
    const uy = dy / dist;
    const radius = targetNode ? NODE_RADIUS[targetNode.kind as NodeKind] ?? 8 : 8;
    const tipX = b.x - ux * (radius + 2);
    const tipY = b.y - uy * (radius + 2);
    const size = 7 / Math.max(0.6, Math.min(2, this.scale));
    ctx.beginPath();
    ctx.moveTo(tipX, tipY);
    ctx.lineTo(tipX - ux * size + uy * size * 0.45, tipY - uy * size - ux * size * 0.45);
    ctx.lineTo(tipX - ux * size - uy * size * 0.45, tipY - uy * size + ux * size * 0.45);
    ctx.closePath();
    ctx.fillStyle = color;
    ctx.fill();
  }

  // ------------------------------ 导出 ------------------------------

  private contentBounds(padding = 40): { minX: number; minY: number; maxX: number; maxY: number } {
    const xs: number[] = [];
    const ys: number[] = [];
    const radii: number[] = [];
    for (const n of this.graph.nodes) {
      const p = this.positions.get(n.id);
      if (!p) continue;
      xs.push(p.x);
      ys.push(p.y);
      radii.push(p.radius);
    }
    if (xs.length === 0) return { minX: 0, minY: 0, maxX: 800, maxY: 600 };

    // 对坐标做 2% 截尾：即使个别离群点跑得很远，也不会把整张图缩成一个点
    xs.sort((a, b) => a - b);
    ys.sort((a, b) => a - b);
    const maxRadius = radii.length > 0 ? Math.max(...radii) : 8;
    const trim = xs.length >= 10 ? Math.floor(xs.length * 0.02) : 0;
    const lo = trim;
    const hi = xs.length - 1 - trim;
    return {
      minX: xs[lo] - maxRadius - padding,
      minY: ys[lo] - maxRadius - padding,
      maxX: xs[hi] + maxRadius + padding,
      maxY: ys[hi] + maxRadius + padding
    };
  }

  /** 渲染到离屏画布（用于导出 PNG，与当前视图无关，导出全图） */
  renderToCanvas(scale = 2): HTMLCanvasElement {
    const bounds = this.contentBounds();
    const off = document.createElement('canvas');
    off.width = Math.min(Math.max(64, Math.ceil((bounds.maxX - bounds.minX) * scale)), 8000);
    off.height = Math.min(Math.max(64, Math.ceil((bounds.maxY - bounds.minY) * scale)), 8000);
    const ctx = off.getContext('2d');
    if (!ctx) return off;
    ctx.fillStyle = '#1e1e1e';
    ctx.fillRect(0, 0, off.width, off.height);

    const savedScale = this.scale;
    const savedTx = this.tx;
    const savedTy = this.ty;
    this.scale = scale;
    this.tx = -bounds.minX * scale;
    this.ty = -bounds.minY * scale;
    try {
      ctx.save();
      ctx.translate(this.tx, this.ty);
      ctx.scale(this.scale, this.scale);
      this.drawForExport(ctx, bounds);
      ctx.restore();
    } finally {
      this.scale = savedScale;
      this.tx = savedTx;
      this.ty = savedTy;
    }
    return off;
  }

  private drawForExport(
    ctx: CanvasRenderingContext2D,
    bounds: { minX: number; minY: number; maxX: number; maxY: number }
  ): void {
    ctx.lineWidth = 1 / this.scale;
    for (const e of this.graph.edges) {
      const a = this.positions.get(e.from);
      const b = this.positions.get(e.to);
      if (!a || !b) continue;
      ctx.globalAlpha = 0.6;
      ctx.strokeStyle = EDGE_COLORS[e.kind as EdgeKind] ?? '#888';
      ctx.beginPath();
      ctx.moveTo(a.x, a.y);
      ctx.lineTo(b.x, b.y);
      ctx.stroke();
    }
    for (const n of this.graph.nodes) {
      const p = this.positions.get(n.id);
      if (!p) continue;
      ctx.globalAlpha = 1;
      ctx.beginPath();
      ctx.arc(p.x, p.y, p.radius, 0, Math.PI * 2);
      ctx.fillStyle = n.external ? '#6b7280' : NODE_COLORS[n.kind as NodeKind] ?? '#999';
      ctx.fill();
      ctx.lineWidth = 1.4 / this.scale;
      ctx.strokeStyle = 'rgba(0,0,0,0.4)';
      ctx.stroke();
    }
    ctx.globalAlpha = 1;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'top';
    ctx.font = `400 ${11 / this.scale}px sans-serif`;
    ctx.fillStyle = '#f0f0f0';
    for (const n of this.graph.nodes) {
      const p = this.positions.get(n.id);
      if (!p) continue;
      if (p.x < bounds.minX || p.x > bounds.maxX || p.y < bounds.minY || p.y > bounds.maxY) continue;
      ctx.fillText(truncate(n.name, 24), p.x, p.y + p.radius + 3 / this.scale);
    }
  }

  /** 导出 SVG（矢量，便于放进文档/PPT） */
  toSvg(): string {
    const bounds = this.contentBounds();
    const w = Math.ceil(bounds.maxX - bounds.minX);
    const h = Math.ceil(bounds.maxY - bounds.minY);
    const ox = -bounds.minX;
    const oy = -bounds.minY;
    const esc = (s: string) =>
      s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

    const parts: string[] = [];
    parts.push(
      `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}">`
    );
    parts.push('<defs><marker id="arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse"><path d="M 0 0 L 10 5 L 0 10 z" fill="#888"/></marker></defs>');
    parts.push(`<rect width="${w}" height="${h}" fill="#1e1e1e"/>`);
    parts.push('<g id="edges" fill="none" stroke-width="1">');
    for (const e of this.graph.edges) {
      const a = this.positions.get(e.from);
      const b = this.positions.get(e.to);
      if (!a || !b) continue;
      const color = EDGE_COLORS[e.kind as EdgeKind] ?? '#888';
      const dash = e.precision === 'approx' ? ' stroke-dasharray="4 3"' : '';
      parts.push(
        `<line x1="${a.x + ox}" y1="${a.y + oy}" x2="${b.x + ox}" y2="${b.y + oy}" stroke="${color}" opacity="0.55"${dash} marker-end="url(#arrow)"><title>${e.kind}</title></line>`
      );
    }
    parts.push('</g><g id="nodes">');
    for (const n of this.graph.nodes) {
      const p = this.positions.get(n.id);
      if (!p) continue;
      const color = n.external ? '#6b7280' : NODE_COLORS[n.kind as NodeKind] ?? '#999';
      parts.push(
        `<circle cx="${p.x + ox}" cy="${p.y + oy}" r="${p.radius}" fill="${color}" stroke="#111" stroke-width="1"><title>${esc(n.name)} (${n.kind})</title></circle>`
      );
      parts.push(
        `<text x="${p.x + ox}" y="${p.y + oy + p.radius + 11}" fill="#f0f0f0" font-size="11" text-anchor="middle" font-family="sans-serif">${esc(truncate(n.name, 24))}</text>`
      );
    }
    parts.push('</g></svg>');
    return parts.join('\n');
  }
}

function truncate(s: string, max: number): string {
  if (s.length <= max) return s;
  return `${s.slice(0, max - 1)}…`;
}
