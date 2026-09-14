// Webview HTML 生成（纯函数，不依赖 vscode —— 便于离线渲染 + 语法自检，见 scripts/check-webview.mjs）
export interface WebviewHtmlOptions {
  cspSource: string;
  scriptUri: string;
  styleUri: string;
  nonce: string;
  lang: string;
  title: string;
  i18n: Record<string, string>;
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/** 内嵌 JSON 数据块：转义 < & 以避免提前闭合标签 / 破坏 CSP */
export function embedJson(value: unknown): string {
  return JSON.stringify(value).replace(/</g, '\\u003c').replace(/&/g, '\\u0026').replace(/>/g, '\\u003e');
}

export function renderGraphHtml(options: WebviewHtmlOptions): string {
  const { cspSource, scriptUri, styleUri, nonce, lang, title, i18n } = options;
  const t = (key: string, fallback: string): string => escapeHtml(i18n[key] ?? fallback);
  const csp = [
    "default-src 'none'",
    `img-src ${cspSource} data:`,
    `style-src ${cspSource} 'unsafe-inline'`,
    `font-src ${cspSource}`,
    `script-src 'nonce-${nonce}'`
  ].join('; ');

  return `<!DOCTYPE html>
<html lang="${escapeHtml(lang)}">
<head>
<meta charset="UTF-8" />
<meta name="viewport" content="width=device-width, initial-scale=1.0" />
<meta http-equiv="Content-Security-Policy" content="${csp}" />
<link rel="stylesheet" href="${styleUri}" />
<title>${escapeHtml(title)}</title>
</head>
<body>
<div id="app">
  <header id="toolbar">
    <div class="group">
      <span id="focus-label">${t('graph.focusLabel', 'Focus')}</span>
    </div>
    <div class="group">
      <label for="input-depth">${t('graph.depth', 'Depth k')}</label>
      <button id="btn-depth-minus" class="icon" title="-1" aria-label="decrease depth">−</button>
      <input id="input-depth" type="number" min="1" max="6" value="2" />
      <span id="depth-value" hidden>2</span>
      <button id="btn-depth-plus" class="icon" title="+1" aria-label="increase depth">+</button>
    </div>
    <div class="group">
      <label for="sel-direction">${t('graph.direction', 'Direction')}</label>
      <select id="sel-direction">
        <option value="both">${t('graph.both', 'Both')}</option>
        <option value="upstream">${t('graph.upstream', 'Upstream')}</option>
        <option value="downstream">${t('graph.downstream', 'Downstream')}</option>
      </select>
    </div>
    <div class="group">
      <label><input id="chk-external" type="checkbox" /> ${t('graph.showExternal', 'Show external')}</label>
      <label><input id="chk-cluster" type="checkbox" /> ${t('graph.cluster', 'Cluster')}</label>
      <label><input id="chk-clickopen" type="checkbox" checked /> ${t('graph.clickToOpen', 'Click to open')}</label>
    </div>
    <div class="group">
      <button id="btn-fit" title="${t('graph.fit', 'Fit')}">⤢</button>
      <button id="btn-refresh" title="${t('graph.refresh', 'Refresh')}">⟳</button>
      <button id="btn-arch" title="${t('graph.architecture', 'Architecture')}">▦</button>
    </div>
    <div class="group">
      <button id="btn-export-png" title="${t('graph.exportPng', 'Export PNG')}">PNG</button>
      <button id="btn-export-svg" title="${t('graph.exportSvg', 'Export SVG')}">SVG</button>
      <button id="btn-export-json" title="${t('graph.exportJson', 'Export JSON')}">JSON</button>
      <button id="btn-export-dot" title="${t('graph.exportDot', 'Export DOT')}">DOT</button>
      <button id="btn-export-mermaid" title="${t('graph.exportMermaid', 'Export Mermaid')}">MMD</button>
    </div>
    <div class="group">
      <input id="search" type="text" placeholder="${t('graph.search', 'Search nodes…')}" />
    </div>
    <div class="group">
      <label for="sel-language">${t('graph.language', 'Language')}</label>
      <select id="sel-language">
        <option value="auto">${t('graph.languageAuto', 'Follow VS Code')}</option>
        <option value="zh">${t('graph.languageZh', '中文')}</option>
        <option value="en">${t('graph.languageEn', 'English')}</option>
      </select>
    </div>
  </header>

  <div id="tabs">
    <button id="tab-graph" class="active">${t('graph.viewGraph', 'Graph')}</button>
    <button id="tab-tree">${t('graph.viewTree', 'Tree')}</button>
    <button id="tab-table">${t('graph.viewTable', 'Table')}</button>
  </div>

  <main>
    <section id="view-graph">
      <canvas id="graph-canvas"></canvas>
      <div id="overlay" class="hidden"></div>
    </section>
    <section id="view-tree" class="hidden"><div id="tree-root"></div></section>
    <section id="view-table" class="hidden">
      <table>
        <thead>
          <tr>
            <th>${t('table.node', 'Node')}</th>
            <th>${t('table.kind', 'Kind')}</th>
            <th>${t('table.outDeps', 'Out')}</th>
            <th>${t('table.inDeps', 'In')}</th>
            <th>${t('table.file', 'File')}</th>
            <th>${t('table.precision', 'Precision')}</th>
          </tr>
        </thead>
        <tbody id="table-body"></tbody>
      </table>
    </section>
  </main>

  <aside>
    <div id="details"><div class="muted">${t('graph.hint', '')}</div></div>
    <div>
      <div class="muted">${t('graph.legend', 'Legend')}</div>
      <div id="legend"></div>
    </div>
  </aside>

  <footer id="status"></footer>
</div>
<div id="toast" class="hidden"></div>
<div id="i18n" hidden>${embedJson(i18n)}</div>
<script nonce="${nonce}" src="${scriptUri}"></script>
</body>
</html>`;
}
