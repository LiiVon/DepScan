// 轻量力导向布局：斥力 + 弹簧 + 碰撞分离 + 向心收拢。
// 不使用任何第三方库（保证离线可用、体积可控）。
// 复杂度 O(n²) 但带距离截断，节点数超过阈值时由调用方改用网格布局。

export interface SimNode {
  id: string;
  x: number;
  y: number;
  vx: number;
  vy: number;
  radius: number;
  pinned: boolean;
}

export interface SimLink {
  source: number;
  target: number;
  idealLength: number;
  strength: number;
}

const DEFAULT_SIZE = 900;

/** 画布尺寸退化（0 或 NaN）时退回安全值，避免布局在无效坐标系里计算 */
function sane(v: number): number {
  return Number.isFinite(v) && v > 1 ? v : DEFAULT_SIZE;
}

/** FNV-1a：用于从节点 id 推导确定性的初始角度 */
function hashCode(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

export class ForceLayout {
  nodes: SimNode[] = [];
  links: SimLink[] = [];
  alpha = 1;
  private width: number;
  private height: number;
  private indexById = new Map<string, number>();

  constructor(width: number, height: number) {
    this.width = sane(width);
    this.height = sane(height);
  }

  setSize(width: number, height: number): void {
    if (width > 1 && height > 1) {
      this.width = width;
      this.height = height;
    }
  }

  setData(
    nodes: Array<{ id: string; radius: number }>,
    links: Array<{ source: string; target: string; kind: string }>
  ): void {
    this.indexById.clear();
    // 黄金角螺旋初值：位置确定、互不重合，且均匀铺满整个盒子。
    // 这一点很关键 —— 早期用「同半径圆环」时，一旦画布尺寸为 0，
    // 所有节点会落在同一点，斥力（与距离平方成反比）会直接炸掉。
    const cx = this.width / 2;
    const cy = this.height / 2;
    const rx = this.width * 0.42;
    const ry = this.height * 0.42;
    this.nodes = nodes.map((n, i) => {
      this.indexById.set(n.id, i);
      // 半径按序号均匀铺开（保证互不重合），角度由 id 哈希决定 ——
      // 这样同类型节点不会被排到同一片区域，避免"看起来分区"的误导。
      const r = Math.sqrt((i + 0.5) / Math.max(1, nodes.length));
      const angle = ((hashCode(n.id) % 4096) / 4096) * Math.PI * 2 + i * 0.0007;
      return {
        id: n.id,
        x: cx + Math.cos(angle) * rx * r,
        y: cy + Math.sin(angle) * ry * r,
        vx: 0,
        vy: 0,
        radius: n.radius,
        pinned: false
      };
    });
    this.links = [];
    const seen = new Set<string>();
    for (const l of links) {
      const s = this.indexById.get(l.source);
      const t = this.indexById.get(l.target);
      if (s === undefined || t === undefined || s === t) continue;
      const key = `${s}-${t}`;
      if (seen.has(key)) continue;
      seen.add(key);
      this.links.push({
        source: s,
        target: t,
        idealLength: 90 + Math.random() * 30,
        strength: 0.35
      });
    }
    this.alpha = 1;
  }

  pin(id: string, x: number, y: number): void {
    const i = this.indexById.get(id);
    if (i === undefined) return;
    this.nodes[i].pinned = true;
    this.nodes[i].x = x;
    this.nodes[i].y = y;
    this.nodes[i].vx = 0;
    this.nodes[i].vy = 0;
  }

  release(id: string): void {
    const i = this.indexById.get(id);
    if (i !== undefined) this.nodes[i].pinned = false;
  }

  step(): void {
    const n = this.nodes.length;
    if (n === 0) return;
    const cx = this.width / 2;
    const cy = this.height / 2;
    const cutoff = 420;
    const cutoff2 = cutoff * cutoff;

    // 斥力（带截断的成对计算）
    for (let i = 0; i < n; i++) {
      const a = this.nodes[i];
      for (let j = i + 1; j < n; j++) {
        const b = this.nodes[j];
        let dx = b.x - a.x;
        let dy = b.y - a.y;
        let d2 = dx * dx + dy * dy;
        if (d2 > cutoff2) continue;
        if (d2 < 1e-6) {
          dx = (Math.random() - 0.5) * 2;
          dy = (Math.random() - 0.5) * 2;
          d2 = dx * dx + dy * dy + 1e-6;
        }
        const dist = Math.sqrt(d2);
        // 距离下限：避免两节点几乎重合时斥力趋于无穷（这是布局"爆炸"的另一个来源）
        const repulse = (2400 * this.alpha) / Math.max(d2, 140);
        const fx = (dx / dist) * repulse;
        const fy = (dy / dist) * repulse;
        a.vx -= fx;
        a.vy -= fy;
        b.vx += fx;
        b.vy += fy;

        // 碰撞分离：避免节点重叠
        const minDist = a.radius + b.radius + 6;
        if (dist < minDist) {
          const push = (minDist - dist) * 0.6;
          const px = (dx / dist) * push;
          const py = (dy / dist) * push;
          a.vx -= px;
          a.vy -= py;
          b.vx += px;
          b.vy += py;
        }
      }
    }

    // 弹簧引力
    for (const l of this.links) {
      const a = this.nodes[l.source];
      const b = this.nodes[l.target];
      const dx = b.x - a.x;
      const dy = b.y - a.y;
      const dist = Math.sqrt(dx * dx + dy * dy) || 1e-6;
      const delta = (dist - l.idealLength) / dist;
      const force = delta * l.strength * this.alpha;
      const fx = dx * force;
      const fy = dy * force;
      a.vx += fx;
      a.vy += fy;
      b.vx -= fx;
      b.vy -= fy;
    }

    // 向心 + 阻尼积分
    for (const node of this.nodes) {
      if (node.pinned) {
        node.vx = 0;
        node.vy = 0;
        continue;
      }
      node.vx += (cx - node.x) * 0.0016 * this.alpha;
      node.vy += (cy - node.y) * 0.0016 * this.alpha;
      node.vx *= 0.82;
      node.vy *= 0.82;
      // 限制单步速度，避免"炸开"
      const speed = Math.hypot(node.vx, node.vy);
      const maxSpeed = 16;
      if (speed > maxSpeed) {
        node.vx = (node.vx / speed) * maxSpeed;
        node.vy = (node.vy / speed) * maxSpeed;
      }
      node.x += node.vx;
      node.y += node.vy;

      // 硬边界：保证任何节点都不会跑出布局盒子，
      // 这样 fitToContent 的包围盒永远有界，不会出现"整图缩成一个小点"。
      const pad = 30;
      node.x = Math.min(this.width - pad, Math.max(pad, node.x));
      node.y = Math.min(this.height - pad, Math.max(pad, node.y));
    }

    this.alpha = Math.max(0.02, this.alpha * 0.985);
  }

  run(steps = 260): void {
    for (let i = 0; i < steps; i++) this.step();
  }

  /** 超大图或聚类视图：按网格确定性排布，避免 O(n²) 卡顿 */
  static gridLayout(
    width: number,
    height: number,
    nodes: Array<{ id: string; radius: number }>
  ): SimNode[] {
    const count = nodes.length;
    const cols = Math.max(1, Math.ceil(Math.sqrt(count * (width / Math.max(1, height)))));
    const rows = Math.ceil(count / cols);
    const cellW = width / (cols + 1);
    const cellH = height / (rows + 1);
    return nodes.map((nd, i) => {
      const col = i % cols;
      const row = Math.floor(i / cols);
      return {
        id: nd.id,
        x: cellW * (col + 1),
        y: cellH * (row + 1),
        vx: 0,
        vy: 0,
        radius: nd.radius,
        pinned: false
      };
    });
  }
}
