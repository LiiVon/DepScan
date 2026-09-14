// 泳道图页面的 HTML 生成（纯函数，不依赖 vscode —— 与 webviewHtml.ts 同一套路，
// 便于离线渲染 + 自查，见 scripts/test-swimlane.mjs）。
//
// 关键取舍：**SVG 是插件侧生成好的字符串，页面里的脚本只做缩放/导出/点击**。
// 把绘制留在插件侧有两个好处：
//  1. 布局与图形能离线断言（列不重叠、箭头向右、转义正确），不用等肉眼；
//  2. 页面上的图与「导出 SVG」写出的是同一份字符串，不会出现"看起来不一样"。
import { esc } from './swimlane';

export interface SwimlaneHtmlOptions {
  cspSource: string;
  scriptUri: string;
  nonce: string;
  lang: string;
  /** 面板标题（工具栏与 <title> 共用） */
  title: string;
  /** 规模行：13 步 · 8 个文件 · 5 次换文件 */
  status: string;
  /** 可选的告警行（例如「图太大只画了前 N 步」） */
  notice?: string;
  /** 已生成的泳道图 SVG；没有路线时不给 */
  svg?: string;
  /** 没有路线时显示的说明 */
  emptyText: string;
  /** 打平后的界面文案（buildSwimlaneStrings 的产物） */
  i18n: Record<string, string>;
}

export function renderSwimlaneHtml(options: SwimlaneHtmlOptions): string {
  const { cspSource, scriptUri, nonce, lang, title, status, notice, svg, emptyText, i18n } = options;
  const t = (key: string, fallback: string): string => esc(i18n[key] ?? fallback);
  const csp = [
    "default-src 'none'",
    `img-src ${cspSource} data:`,
    `style-src ${cspSource} 'unsafe-inline'`,
    `font-src ${cspSource}`,
    `script-src 'nonce-${nonce}'`
  ].join('; ');

  return `<!DOCTYPE html>
<html lang="${esc(lang)}">
<head>
<meta charset="UTF-8" />
<meta name="viewport" content="width=device-width, initial-scale=1.0" />
<meta http-equiv="Content-Security-Policy" content="${csp}" />
<title>${esc(title)}</title>
<style>
:root { color-scheme: light dark; }
html, body { margin: 0; padding: 0; height: 100%; }
body {
  display: flex; flex-direction: column; height: 100vh;
  background: var(--vscode-editor-background); color: var(--vscode-foreground);
  font-family: var(--vscode-font-family, sans-serif); font-size: 12px;
}
#toolbar {
  display: flex; align-items: center; gap: 12px; flex-wrap: wrap;
  padding: 6px 10px; border-bottom: 1px solid var(--vscode-panel-border, #3c3c3c);
  background: var(--vscode-editorWidget-background, transparent);
}
#toolbar .group { display: flex; align-items: center; gap: 6px; }
#toolbar strong { font-weight: 600; }
button {
  font: inherit; cursor: pointer; padding: 2px 8px; border-radius: 3px;
  color: var(--vscode-button-secondaryForeground, var(--vscode-foreground));
  background: var(--vscode-button-secondaryBackground, rgba(127,127,127,.18));
  border: 1px solid var(--vscode-panel-border, transparent);
}
button:hover { background: var(--vscode-button-secondaryHoverBackground, rgba(127,127,127,.3)); }
#zoom-label { min-width: 40px; text-align: center; opacity: .8; font-variant-numeric: tabular-nums; }
#hint, #status { margin: 0; padding: 4px 10px; }
#hint { opacity: .75; line-height: 1.5; }
#hint .muted { opacity: .8; }
#status { opacity: .85; font-variant-numeric: tabular-nums; }
#notice {
  margin: 0; padding: 4px 10px; line-height: 1.5;
  color: var(--vscode-editorWarning-foreground, #cca700);
}
#stage { flex: 1; display: flex; min-height: 0; }
/* 画布式导航：不用原生滚动条，而是拖拽平移 + 滚轮缩放（与依赖图面板同一种手感）。
   overflow:hidden + transform 才做得到「以鼠标位置为锚点缩放」。 */
#viewport {
  flex: 1; position: relative; overflow: hidden;
  cursor: grab; touch-action: none;
}
#viewport.ds-panning { cursor: grabbing; }
#canvas { position: absolute; top: 0; left: 0; transform-origin: 0 0; will-change: transform; }
#canvas svg { display: block; }
#legend {
  width: 250px; flex: none; padding: 8px 10px; overflow: auto;
  border-left: 1px solid var(--vscode-panel-border, #3c3c3c);
  background: var(--vscode-sideBar-background, transparent);
}
.legend-title { opacity: .75; margin-bottom: 6px; }
#legend ul { list-style: none; margin: 0; padding: 0; }
#legend li { display: flex; align-items: center; gap: 8px; margin: 5px 0; line-height: 1.4; }
.swatch { width: 14px; height: 14px; flex: none; border-radius: 50%; }
.swatch-step { background: var(--vscode-button-background, #0e639c); }
.swatch-ambiguous { background: var(--vscode-charts-yellow, #cca700); }
.swatch-cross { width: 16px; height: 3px; border-radius: 0; background: var(--vscode-charts-orange, #d18616); }
.swatch-same { width: 16px; height: 3px; border-radius: 0; background: var(--vscode-descriptionForeground, #6b6b6b); }
#empty { padding: 24px 12px; opacity: .85; line-height: 1.6; }
[hidden] { display: none !important; }
</style>
</head>
<body>
<header id="toolbar">
  <div class="group"><strong id="title">${esc(title)}</strong></div>
  <div class="group">
    <button id="btn-zoom-out" title="${t('zoomOut', 'Zoom out')}">−</button>
    <span id="zoom-label">100%</span>
    <button id="btn-zoom-in" title="${t('zoomIn', 'Zoom in')}">+</button>
    <button id="btn-fit">${t('fit', 'Fit width')}</button>
    <button id="btn-reset">${t('reset', 'Actual size')}</button>
  </div>
  <div class="group">
    <button id="btn-export">${t('exportSvg', 'Export SVG')}</button>
    <button id="btn-refresh" title="${t('refresh', 'Regenerate')}">⟳</button>
  </div>
</header>
<p id="hint">${t('hint', '')}<br /><span class="muted">${t('navHint', '')}</span></p>
<div id="status">${esc(status)}</div>
<p id="notice"${notice ? '' : ' hidden'}>${esc(notice ?? '')}</p>
<main id="stage">
  <div id="viewport"${svg ? '' : ' hidden'}><div id="canvas">${svg ?? ''}</div></div>
  <div id="empty"${svg ? ' hidden' : ''}>${esc(emptyText)}</div>
  <aside id="legend"${svg ? '' : ' hidden'}>
    <div class="legend-title">${t('legend', 'Legend')}</div>
    <ul>
      <li><span class="swatch swatch-step"></span>${t('legendStep', 'One reading step')}</li>
      <li><span class="swatch swatch-ambiguous"></span>${t('legendAmbiguous', 'Same-named definition')}</li>
      <li><span class="swatch swatch-cross"></span>${t('legendCross', 'Cross-file move')}</li>
      <li><span class="swatch swatch-same"></span>${t('legendSame', 'Same-file call')}</li>
    </ul>
  </aside>
</main>
<div id="i18n" hidden>${embedJson(i18n)}</div>
<script nonce="${nonce}" src="${scriptUri}"></script>
</body>
</html>`;
}

/** 内嵌 JSON 数据块：转义 < & > 以避免提前闭合标签 / 破坏 CSP */
export function embedJson(value: unknown): string {
  return JSON.stringify(value)
    .replace(/</g, '\\u003c')
    .replace(/&/g, '\\u0026')
    .replace(/>/g, '\\u003e');
}
