// 泳道图页面的前端脚本：**只做四件事** —— 缩放、适应宽度、导出、点击跳源码。
//
// 布局和绘制都在插件侧生成好 SVG 了。这是刻意的：Webview 里每多一行画布代码，
// 就多一个「编译通过、类型正确，但打开页面一片空白」的机会，
// 而这类问题只能在人肉打开页面时才发现（这个项目已经踩过一次）。
import type { SwimlaneToHost, SwimlaneToWebview } from './types';

interface VsCodeApi {
  postMessage(message: SwimlaneToHost): void;
  getState(): unknown;
  setState(state: unknown): void;
}

declare function acquireVsCodeApi(): VsCodeApi;

const vscode = acquireVsCodeApi();

const MIN_SCALE = 0.2;
const MAX_SCALE = 4;
const STEP = 1.25;

const zoomLabel = document.getElementById('zoom-label');
const canvas = document.getElementById('canvas');
const viewport = document.getElementById('viewport');
const legend = document.getElementById('legend');
const emptyBox = document.getElementById('empty');
const titleEl = document.getElementById('title');
const statusEl = document.getElementById('status');
const noticeEl = document.getElementById('notice');

let svg: SVGSVGElement | undefined;
/** SVG 的固有尺寸（插件侧按布局算好写在 width/height 上） */
let baseWidth = 0;
let baseHeight = 0;
/** 视图变换：tx/ty 是屏幕坐标下的平移量，先缩放再平移（与依赖图面板同一套） */
let scale = 1;
let tx = 0;
let ty = 0;
/** 只在第一次拿到图时自动适应宽度 —— 之后重新生成不动用户调好的视图 */
let fitted = false;

function clamp(value: number): number {
  return Math.min(MAX_SCALE, Math.max(MIN_SCALE, value));
}

/** 记下当前 SVG 的固有尺寸。图是宿主送进来的，所以每次换图都要重新读一次。 */
function adoptSvg(): void {
  svg = canvas?.querySelector('svg') ?? undefined;
  // 固有尺寸只认属性：缩放改的是 #canvas 的 transform，不去动 svg 自己的 style
  baseWidth = Number(svg?.getAttribute('width')) || 0;
  baseHeight = Number(svg?.getAttribute('height')) || 0;
  svg?.removeAttribute('style');
}

/** 缩放与平移一次性交给 transform —— 矢量放大不糊，且能做到以鼠标位置为锚点 */
function applyView(): void {
  if (!canvas) return;
  canvas.style.transform = `translate(${tx}px, ${ty}px) scale(${scale})`;
  if (zoomLabel) zoomLabel.textContent = `${Math.round(scale * 100)}%`;
}

function screenToWorld(x: number, y: number): { x: number; y: number } {
  return { x: (x - tx) / scale, y: (y - ty) / scale };
}

/**
 * 以某个屏幕点为锚点缩放：这个点底下的内容不动 —— 放大时不会「跑掉」。
 * 不给锚点时以视口中心为锚（工具栏的 +/− 与键盘走这条）。
 */
function zoomBy(factor: number, anchor?: { x: number; y: number }): void {
  if (!viewport || !baseWidth) return;
  const a = anchor ?? { x: viewport.clientWidth / 2, y: viewport.clientHeight / 2 };
  const before = screenToWorld(a.x, a.y);
  scale = clamp(scale * factor);
  const after = screenToWorld(a.x, a.y);
  tx += (after.x - before.x) * scale;
  ty += (after.y - before.y) * scale;
  applyView();
}

/** 把内容摆到「缩放值已定」后的位置：横向居中，纵向尽量靠上（阅读顺序是从上往下） */
function placeContent(targetScale: number): void {
  if (!viewport || !baseWidth) return;
  scale = clamp(targetScale);
  tx = (viewport.clientWidth - baseWidth * scale) / 2;
  ty = Math.max(8, (viewport.clientHeight - baseHeight * scale) / 2);
  applyView();
}

/** 适应宽度：只往小里缩（放大到超过原始尺寸反而更难看），下限 20% */
function fitWidth(): void {
  if (!viewport || !baseWidth) return;
  placeContent((viewport.clientWidth - 24) / baseWidth);
}

/** 原始大小：100%，并回到内容左上角 —— 那里是阅读顺序的起点 */
function resetView(): void {
  placeContent(1);
}

/**
 * 限制平移范围：内容永远至少留 60px 在视口里。
 * 没有这道约束，一次大幅拖拽就能把图甩出屏幕，而且再也找不回来。
 */
function clampPan(): void {
  if (!viewport || !baseWidth) return;
  const keep = 60;
  const contentWidth = baseWidth * scale;
  const contentHeight = baseHeight * scale;
  tx = Math.min(Math.max(tx, -(contentWidth - keep)), viewport.clientWidth - keep);
  ty = Math.min(Math.max(ty, -(contentHeight - keep)), viewport.clientHeight - keep);
}

function showSvg(message: { svg: string; title: string; status: string; notice?: string }): void {
  if (!canvas) return;
  // 只换画布内容，不重建页面 —— 否则每次保存文件都会把用户调好的视图打回去
  canvas.innerHTML = message.svg;
  if (titleEl) titleEl.textContent = message.title;
  if (statusEl) statusEl.textContent = message.status;
  if (noticeEl) {
    noticeEl.textContent = message.notice ?? '';
    noticeEl.hidden = !message.notice;
  }
  viewport?.removeAttribute('hidden');
  legend?.removeAttribute('hidden');
  emptyBox?.setAttribute('hidden', '');
  adoptSvg();
  if (fitted) applyView();
  else {
    fitted = true;
    fitWidth();
  }
}

function showEmpty(message: { message: string; title: string }): void {
  if (canvas) canvas.innerHTML = '';
  svg = undefined;
  baseWidth = 0;
  scale = 1;
  tx = 0;
  ty = 0;
  fitted = false;
  if (emptyBox) {
    emptyBox.textContent = message.message;
    emptyBox.removeAttribute('hidden');
  }
  viewport?.setAttribute('hidden', '');
  legend?.setAttribute('hidden', '');
  if (titleEl) titleEl.textContent = message.title;
  if (statusEl) statusEl.textContent = '';
  if (noticeEl) noticeEl.hidden = true;
}

// ------------------------------ 导航：拖拽平移 + 滚轮缩放 ------------------------------
// 与依赖图面板同一套约定（同样是 1.12 倍），不然同一个插件里两个图手感不一样才叫奇怪。

let panning = false;
let panOrigin = { x: 0, y: 0 };
let downAt = { x: 0, y: 0 };
/** 按下后有没有真的移动过 —— 用来区分「拖拽」和「点一下跳源码」 */
let movedSinceDown = false;

viewport?.addEventListener(
  'wheel',
  (event) => {
    if (!viewport || !baseWidth) return;
    event.preventDefault();
    const rect = viewport.getBoundingClientRect();
    // 缩放量随 deltaY 连续变化，而不是「一格 = 1.12 倍」：
    // 鼠标滚轮一格（deltaY ≈ 120）约 1.17 倍，与依赖图面板的 1.12 基本一致；
    // 而触控板会一次发很多个小 delta，固定倍数会一下子缩到底。
    const delta = event.deltaMode === 1 ? event.deltaY * 16 : event.deltaY;
    const factor = Math.pow(1.0013, -delta);
    zoomBy(factor, {
      x: event.clientX - rect.left,
      y: event.clientY - rect.top
    });
  },
  { passive: false }
);

viewport?.addEventListener('pointerdown', (event) => {
  if (!viewport || !baseWidth) return;
  // 只响应左键 / 触控笔 / 触摸；中键右键留给浏览器的默认行为
  if (event.pointerType === 'mouse' && event.button !== 0) return;
  viewport.setPointerCapture(event.pointerId);
  const rect = viewport.getBoundingClientRect();
  panning = true;
  movedSinceDown = false;
  downAt = { x: event.clientX - rect.left, y: event.clientY - rect.top };
  panOrigin = { x: downAt.x - tx, y: downAt.y - ty };
  viewport.classList.add('ds-panning');
});

viewport?.addEventListener('pointermove', (event) => {
  if (!panning || !viewport) return;
  const rect = viewport.getBoundingClientRect();
  const x = event.clientX - rect.left;
  const y = event.clientY - rect.top;
  if (Math.hypot(x - downAt.x, y - downAt.y) > 4) movedSinceDown = true;
  tx = x - panOrigin.x;
  ty = y - panOrigin.y;
  clampPan();
  applyView();
});

/**
 * 结束平移。
 *
 * 「点圆点跳源码」也在这里处理，而不是挂一个 click 监听 ——
 * 因为 pointerdown 里调了 setPointerCapture 之后，后续指针事件（含合成出的 click）
 * 的目标会变成**捕获元素（视口）**，挂在 #canvas 上的事件委托再也收不到圆点。
 * 依赖图面板也是在 pointerup 里处理点击的，同一个原因。
 * 拿到坐标后用 elementFromPoint 反查鼠标底下是谁 —— 跟捕获无关，永远准。
 */
const finishPan = (event: PointerEvent, allowClick: boolean): void => {
  if (!panning) return;
  panning = false;
  viewport?.classList.remove('ds-panning');
  try {
    viewport?.releasePointerCapture(event.pointerId);
  } catch {
    /* 指针已经释放过了，忽略 */
  }
  if (!allowClick || movedSinceDown) return;
  const hit = document.elementFromPoint(event.clientX, event.clientY);
  const step = hit?.closest?.('.ds-step');
  if (!step) return;
  const file = step.getAttribute('data-file') ?? '';
  if (!file) return;
  vscode.postMessage({
    type: 'open',
    file,
    line: Number(step.getAttribute('data-line') ?? 1),
    column: Number(step.getAttribute('data-column') ?? 1)
  });
};
viewport?.addEventListener('pointerup', (event) => finishPan(event, true));
viewport?.addEventListener('pointercancel', (event) => finishPan(event, false));

document.getElementById('btn-zoom-in')?.addEventListener('click', () => zoomBy(STEP));
document.getElementById('btn-zoom-out')?.addEventListener('click', () => zoomBy(1 / STEP));
document.getElementById('btn-fit')?.addEventListener('click', fitWidth);
document.getElementById('btn-reset')?.addEventListener('click', resetView);
document.getElementById('btn-export')?.addEventListener('click', () => {
  vscode.postMessage({ type: 'export' });
});
document.getElementById('btn-refresh')?.addEventListener('click', () => {
  vscode.postMessage({ type: 'refresh' });
});

// 键盘也能缩放 / 复位 —— 看图时手不用离开键盘

document.addEventListener('keydown', (event) => {
  if (event.target instanceof HTMLInputElement) return;
  if (event.key === '+' || event.key === '=') zoomBy(STEP);
  else if (event.key === '-' || event.key === '_') zoomBy(1 / STEP);
  else if (event.key === '0') resetView();
  else if (event.key === 'f') fitWidth();
});

// 点击圆点跳源码：在 finishPan 里处理（见上面那段注释 —— click 委托会被指针捕获吃掉）

window.addEventListener('message', (event: MessageEvent<SwimlaneToWebview>) => {
  const message = event.data;
  if (!message || typeof message !== 'object') return;
  if (message.type === 'svg') showSvg(message);
  else if (message.type === 'empty') showEmpty(message);
});

adoptSvg();
applyView();
vscode.postMessage({ type: 'ready' });
