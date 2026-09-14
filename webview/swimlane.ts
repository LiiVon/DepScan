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
let scale = 1;
/** 只在第一次拿到图时自动适应宽度 —— 之后重新生成不动用户的缩放 */
let fitted = false;

function clamp(value: number): number {
  return Math.min(MAX_SCALE, Math.max(MIN_SCALE, value));
}

/** 记下当前 SVG 的固有尺寸。图是宿主送进来的，所以每次换图都要重新读一次。 */
function adoptSvg(): void {
  svg = canvas?.querySelector('svg') ?? undefined;
  baseWidth = Number(svg?.getAttribute('width')) || 0;
  baseHeight = Number(svg?.getAttribute('height')) || 0;
}

/** 缩放的做法：改 SVG 元素的 CSS 尺寸，viewBox 会等比放大 —— 矢量，不糊 */
function applyScale(): void {
  if (!svg || !baseWidth) return;
  svg.style.width = `${baseWidth * scale}px`;
  svg.style.height = `${baseHeight * scale}px`;
  if (zoomLabel) zoomLabel.textContent = `${Math.round(scale * 100)}%`;
}

/** 适应宽度：只往小里缩（放大到超过原始尺寸反而更难看），下限 20% */
function fitWidth(): void {
  if (!svg || !viewport || !baseWidth) return;
  scale = clamp((viewport.clientWidth - 24) / baseWidth);
  applyScale();
}

function zoomBy(factor: number): void {
  scale = clamp(scale * factor);
  applyScale();
}

function showSvg(message: { svg: string; title: string; status: string; notice?: string }): void {
  if (!canvas) return;
  // 只换画布内容，不重建页面 —— 否则每次保存文件都会把缩放打回 100%
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
  if (fitted) applyScale();
  else {
    fitted = true;
    fitWidth();
  }
}

function showEmpty(message: { message: string; title: string }): void {
  if (canvas) canvas.innerHTML = '';
  svg = undefined;
  baseWidth = 0;
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

document.getElementById('btn-zoom-in')?.addEventListener('click', () => zoomBy(STEP));
document.getElementById('btn-zoom-out')?.addEventListener('click', () => zoomBy(1 / STEP));
document.getElementById('btn-fit')?.addEventListener('click', fitWidth);
document.getElementById('btn-reset')?.addEventListener('click', () => {
  scale = 1;
  applyScale();
});
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
  else if (event.key === '0') {
    scale = 1;
    applyScale();
  } else if (event.key === 'f') fitWidth();
});

// 点击圆点跳源码：用事件委托，SVG 是插件侧生成的，这里不需要知道它的结构
canvas?.addEventListener('click', (event) => {
  const target = event.target;
  if (!(target instanceof Element)) return;
  const step = target.closest('.ds-step');
  if (!step) return;
  const file = step.getAttribute('data-file') ?? '';
  if (!file) return;
  vscode.postMessage({
    type: 'open',
    file,
    line: Number(step.getAttribute('data-line') ?? 1),
    column: Number(step.getAttribute('data-column') ?? 1)
  });
});

window.addEventListener('message', (event: MessageEvent<SwimlaneToWebview>) => {
  const message = event.data;
  if (!message || typeof message !== 'object') return;
  if (message.type === 'svg') showSvg(message);
  else if (message.type === 'empty') showEmpty(message);
});

adoptSvg();
applyScale();
vscode.postMessage({ type: 'ready' });
