// 阅读路线的「泳道图」：**每个文件一条横泳道，横轴是步号（也就是阅读顺序）**。
//
// 为什么这张图值得回到画布：TreeView 给的是「调用树」（谁调了谁），
// 泳道图给的是「控制权在哪些文件之间来回」—— 跨泳道的箭头一眼就能看出
// 「第 3 步交给了 A、第 8 步又回到 B」。这件事用文字列表很难讲清楚。
//
// 这里全部是**纯函数**（布局 + SVG 字符串），不依赖 vscode、不依赖 DOM：
//  - 布局可以离线断言（列不重叠、箭头一律向右、跨文件边被标出来）
//  - 导出的 .svg 与页面上看到的是同一份字符串，不会漂
//  - 颜色用 CSS 变量 + 兜底色：在 VS Code 里跟随主题，导出成单文件也能看
import type { RouteResult } from '../engine/protocol';

/** 左侧文件名栏的宽度 */
export const LANE_LABEL_WIDTH = 210;
/** 每条泳道的高度 */
export const LANE_HEIGHT = 56;
/** 画布外边距 */
export const MARGIN = 16;
/** 步骤圆点半径 */
export const MARKER_RADIUS = 13;
/** 圆点圆心相对泳道顶部的偏移（下面还要留一行放名字） */
export const MARKER_OFFSET_Y = 20;
/** 名字基线的偏移 */
export const LABEL_OFFSET_Y = 48;

const MIN_COLUMN_WIDTH = 56;
const COLUMN_PADDING = 24;
/** 等宽字体 12px 的近似字宽 —— SVG 里量不了文本，宁可按大一点算 */
const CHAR_WIDTH = 7.2;
const MAX_LABEL_CHARS = 24;
const MAX_LANE_CHARS = 28;
const EDGE_GAP = 6;

export interface SwimlaneStep {
  order: number;
  /** 完整符号名（悬停提示用） */
  name: string;
  /** 画在图上的名字（过长会截成 …） */
  label: string;
  file: string;
  line: number;
  column: number;
  kind: string;
  ambiguous: boolean;
  external: boolean;
  /** 圆心 x（列宽由名字长度决定，所以名字之间不会互相压住） */
  x: number;
  columnWidth: number;
  laneIndex: number;
}

export interface SwimlaneLane {
  file: string;
  /** 左侧栏显示的文件名（过长从**左边**截断，保留更有信息量的尾部） */
  label: string;
  index: number;
  /** 泳道顶部 y */
  y: number;
  height: number;
  markerY: number;
  labelY: number;
  firstOrder: number;
  steps: SwimlaneStep[];
}

export interface SwimlaneEdge {
  fromOrder: number;
  toOrder: number;
  /** 跨文件 = 控制权交给了另一个文件（画成醒目的颜色，这就是这张图的主角） */
  crossFile: boolean;
  path: string;
}

export interface SwimlaneLayout {
  lanes: SwimlaneLane[];
  edges: SwimlaneEdge[];
  width: number;
  height: number;
  laneLabelWidth: number;
  /** 实际画出来的步骤数 */
  stepCount: number;
  /** 因为超过上限没画的步骤数 */
  droppedCount: number;
  crossFileEdges: number;
}

export interface SwimlaneLayoutOptions {
  /**
   * 最多画多少步。图再宽也读不动了，超出部分只报数不画 ——
   * 报数而不是悄悄截断，是为了让「这图不全」这件事本身可见。
   */
  maxSteps?: number;
}

export function layoutSwimlane(
  result: RouteResult,
  options: SwimlaneLayoutOptions = {}
): SwimlaneLayout {
  const maxSteps = Math.max(1, options.maxSteps ?? 400);
  const visible = result.steps.slice(0, maxSteps);
  const droppedCount = result.steps.length - visible.length;

  // 一步一列。列宽由**这一步自己的**名字长度决定：每个步号只对应一步，
  // 所以列宽不会和别的步骤打架，名字也不必旋转或省略到看不懂。
  const boxes = new Map<number, { x: number; width: number }>();
  let cursor = MARGIN + LANE_LABEL_WIDTH;
  for (const step of visible) {
    const label = ellipsisRight(step.name, MAX_LABEL_CHARS);
    const width = Math.max(MIN_COLUMN_WIDTH, label.length * CHAR_WIDTH + COLUMN_PADDING);
    boxes.set(step.order, { x: cursor + width / 2, width });
    cursor += width;
  }
  const width = cursor + MARGIN;

  // 泳道按**首次进入**的顺序排：阅读时先碰到的文件在上面，流向自然从上往下。
  // 往回指的箭头 = 回到之前读过的文件，这在真实项目里是很常见也很值得注意的动作。
  const lanes: SwimlaneLane[] = [];
  const laneByFile = new Map<string, SwimlaneLane>();
  for (const step of visible) {
    let lane = laneByFile.get(step.file);
    if (!lane) {
      lane = {
        file: step.file,
        label: ellipsisLeft(step.file, MAX_LANE_CHARS),
        index: lanes.length,
        y: MARGIN + lanes.length * LANE_HEIGHT,
        height: LANE_HEIGHT,
        markerY: MARGIN + lanes.length * LANE_HEIGHT + MARKER_OFFSET_Y,
        labelY: MARGIN + lanes.length * LANE_HEIGHT + LABEL_OFFSET_Y,
        firstOrder: step.order,
        steps: []
      };
      lanes.push(lane);
      laneByFile.set(step.file, lane);
    }
    const box = boxes.get(step.order);
    if (!box) continue;
    lane.steps.push({
      order: step.order,
      name: step.name,
      label: ellipsisRight(step.name, MAX_LABEL_CHARS),
      file: step.file,
      line: step.line,
      column: step.column,
      kind: step.kind,
      ambiguous: step.ambiguous,
      external: step.external,
      x: box.x,
      columnWidth: box.width,
      laneIndex: lane.index
    });
  }

  const stepByOrder = new Map<number, SwimlaneStep>();
  for (const lane of lanes) {
    for (const step of lane.steps) stepByOrder.set(step.order, step);
  }

  const edges: SwimlaneEdge[] = [];
  for (const step of visible) {
    if (step.parent === 0) continue;
    const from = stepByOrder.get(step.parent);
    const to = stepByOrder.get(step.order);
    if (!from || !to) continue; // 父步骤被截断掉时，这条边也画不出来
    const crossFile = from.file !== to.file;
    edges.push({
      fromOrder: from.order,
      toOrder: to.order,
      crossFile,
      path: edgePath(from, to, lanes)
    });
  }

  return {
    lanes,
    edges,
    width,
    height: MARGIN * 2 + lanes.length * LANE_HEIGHT,
    laneLabelWidth: LANE_LABEL_WIDTH,
    stepCount: visible.length,
    droppedCount,
    crossFileEdges: edges.filter((e) => e.crossFile).length
  };
}

function edgePath(from: SwimlaneStep, to: SwimlaneStep, lanes: SwimlaneLane[]): string {
  const x1 = from.x + MARKER_RADIUS;
  const y1 = lanes[from.laneIndex].markerY;
  const x2 = to.x - MARKER_RADIUS - EDGE_GAP;
  const y2 = lanes[to.laneIndex].markerY;
  if (y1 === y2) return `M ${round(x1)} ${round(y1)} L ${round(x2)} ${round(y2)}`;
  // 跨泳道：三次贝塞尔，控制点横向拉开，出来是教科书式的 S 形，不会和别的线糊在一起
  const dx = Math.max(0, (x2 - x1) * 0.45);
  return (
    `M ${round(x1)} ${round(y1)} ` +
    `C ${round(x1 + dx)} ${round(y1)}, ${round(x2 - dx)} ${round(y2)}, ${round(x2)} ${round(y2)}`
  );
}

/** 生成泳道图的 SVG。**与导出到磁盘的是同一份字符串。** */
export function renderSwimlaneSvg(layout: SwimlaneLayout): string {
  const parts: string[] = [];
  parts.push(
    `<svg xmlns="http://www.w3.org/2000/svg" class="ds-swimlane" width="${round(layout.width)}" ` +
      `height="${round(layout.height)}" viewBox="0 0 ${round(layout.width)} ${round(layout.height)}" ` +
      `role="img" data-steps="${layout.stepCount}">`
  );
  parts.push(
    '<defs>' +
      '<marker id="ds-arrow" viewBox="0 0 8 8" refX="7" refY="4" markerWidth="7" markerHeight="7" orient="auto">' +
      '<path class="ds-arrow-head" d="M0,0 L8,4 L0,8 z" /></marker>' +
      '<marker id="ds-arrow-cross" viewBox="0 0 8 8" refX="7" refY="4" markerWidth="7" markerHeight="7" orient="auto">' +
      '<path class="ds-arrow-head-cross" d="M0,0 L8,4 L0,8 z" /></marker>' +
      '</defs>'
  );
  parts.push(`<style>${SWIMLANE_CSS}</style>`);

  // 泳道底 + 文件名
  parts.push('<g class="ds-lanes">');
  for (const lane of layout.lanes) {
    parts.push(
      `<rect class="ds-lane${lane.index % 2 ? ' ds-lane-alt' : ''}" x="0" y="${round(lane.y)}" ` +
        `width="${round(layout.width)}" height="${round(lane.height)}" />`
    );
    parts.push(
      `<text class="ds-file" x="${round(layout.laneLabelWidth - 10)}" y="${round(lane.labelY - 6)}" ` +
        `text-anchor="end"><title>${esc(lane.file)}</title>${esc(lane.label)}</text>`
    );
  }
  parts.push('</g>');

  // 边（先画线，圆点压在上面）
  parts.push('<g class="ds-edges">');
  for (const edge of layout.edges) {
    // 箭头颜色必须和线一致：marker 是一个独立图形，只会跟随自己的 fill，
    // 所以这里备了两个 marker 按需选用（而不是指望 context-stroke 这种新特性）。
    const marker = edge.crossFile ? 'ds-arrow-cross' : 'ds-arrow';
    parts.push(
      `<path class="ds-edge${edge.crossFile ? ' ds-edge-cross' : ''}" d="${edge.path}" ` +
        `data-from="${edge.fromOrder}" data-to="${edge.toOrder}" marker-end="url(#${marker})" />`
    );
  }
  parts.push('</g>');

  // 步骤
  parts.push('<g class="ds-steps">');
  for (const lane of layout.lanes) {
    for (const step of lane.steps) {
      const cls = [
        'ds-step',
        step.ambiguous ? 'ds-step-ambiguous' : '',
        step.external ? 'ds-step-external' : ''
      ]
        .filter(Boolean)
        .join(' ');
      const tooltip = `#${step.order} ${step.name} — ${step.file}:${step.line}${
        step.ambiguous ? ' ⚠' : ''
      }`;
      parts.push(
        `<g class="${cls}" data-order="${step.order}" data-file="${esc(step.file)}" ` +
          `data-line="${step.line}" data-column="${step.column}" data-kind="${esc(step.kind)}">` +
          `<title>${esc(tooltip)}</title>` +
          `<circle class="ds-step-bg" cx="${round(step.x)}" cy="${round(lane.markerY)}" r="${MARKER_RADIUS}" />` +
          `<text class="ds-step-num" x="${round(step.x)}" y="${round(lane.markerY + 4)}">${step.order}</text>` +
          `<text class="ds-step-name" x="${round(step.x)}" y="${round(lane.labelY)}">${esc(step.label)}</text>` +
          '</g>'
      );
    }
  }
  parts.push('</g>');

  parts.push('</svg>');
  return parts.join('\n');
}

/**
 * 样式内联在 SVG 里：这样导出的 .svg 是自包含的单文件（在浏览器里直接打开就有颜色），
 * 而在 VS Code 里 `--vscode-*` 变量存在，会自动跟随主题。
 */
const SWIMLANE_CSS = `
.ds-swimlane { background: var(--vscode-editor-background, #1e1e1e); font-family: ui-monospace, Consolas, "Courier New", monospace; }
.ds-lane { fill: var(--vscode-editorWidget-background, #252526); }
.ds-lane-alt { fill: var(--vscode-sideBar-background, #2d2d30); }
.ds-file { fill: var(--vscode-descriptionForeground, #8a8a8a); font-size: 12px; }
.ds-edge { fill: none; stroke: var(--vscode-descriptionForeground, #6b6b6b); stroke-width: 1.2; opacity: .75; }
.ds-edge-cross { stroke: var(--vscode-charts-orange, #d18616); stroke-width: 1.8; opacity: 1; }
.ds-arrow-head { fill: var(--vscode-descriptionForeground, #6b6b6b); }
.ds-arrow-head-cross { fill: var(--vscode-charts-orange, #d18616); }
.ds-step { cursor: pointer; }
.ds-step-bg { fill: var(--vscode-button-background, #0e639c); stroke: var(--vscode-editor-background, #1e1e1e); stroke-width: 2; }
.ds-step:hover .ds-step-bg { fill: var(--vscode-button-hoverBackground, #1177bb); }
.ds-step-ambiguous .ds-step-bg { fill: var(--vscode-charts-yellow, #cca700); }
.ds-step-external .ds-step-bg { fill: var(--vscode-charts-gray, #6b6b6b); }
.ds-step-num { fill: var(--vscode-button-foreground, #ffffff); font-size: 10.5px; text-anchor: middle; pointer-events: none; }
.ds-step-name { fill: var(--vscode-foreground, #cccccc); font-size: 11.5px; text-anchor: middle; pointer-events: none; }
`.trim();

/** XML 转义 —— 文件路径里出现 & 或 < 时不能把 SVG 结构撑坏 */
export function esc(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

export function ellipsisRight(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

/** 从左边截断：`…/util/string_utils.cpp` 比 `src/util/string_ut…` 有用得多 */
export function ellipsisLeft(text: string, max: number): string {
  return text.length > max ? `…${text.slice(text.length - max + 1)}` : text;
}

function round(value: number): number {
  return Math.round(value * 10) / 10;
}
