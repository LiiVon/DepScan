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

export class ForceLayout {
  nodes: SimNode[] = [];
  links: SimLink[] = [];
  alpha = 1;
  private width: number;
  private height: number;
  private indexById = new Map<string, number>();

  constructor(width: number, height: number) {
    this.width = width;
    this.height = height;
  }

  setSize(width: number, height: number): void {
    this.width = width;
    this.height = height;
  }

  setData(
    nodes: Array<{ id: string; radius: number }>,
    links: Array<{ source: string; target: string; kind: string }>
  ): void {
    this.indexById.clear();
    this.nodes = nodes.map((n, i) => {
      this.indexById.set(n.id, i);
      // 以环形初始位置打散，避免全部重合导致斥力方向随机
      const angle = (i / Math.max(1, nodes.length)) * Math.PI * 2;
      const radius = Math.min(this.width, this.height) * 0.35;
      return {
        id: n.id,
        x: this.width / 2 + Math.cos(angle) * radius,
        y: this.height / 2 + Math.sin(angle) * radius,
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
        const repulse = (2400 * this.alpha) / d2;
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
      const maxSpeed = 24;
      if (speed > maxSpeed) {
        node.vx = (node.vx / speed) * maxSpeed;
        node.vy = (node.vy / speed) * maxSpeed;
      }
      node.x += node.vx;
      node.y += node.vy;
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
