// Webview 离线自检：语法 + 元素 id 对齐 + 内嵌 JSON 可解析。
// 这类错误（模板字符串生成的 HTML 与前端脚本不匹配）编译期发现不了，只能在运行时表现为"页面空白"。
import { build } from 'esbuild';
import { readdirSync, readFileSync, existsSync, mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { dirname, join, relative, resolve } from 'path';
import { fileURLToPath, pathToFileURL } from 'url';
import vm from 'vm';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const failures = [];

function check(condition, message) {
  if (condition) {
    console.log(`  [PASS] ${message}`);
  } else {
    failures.push(message);
    console.log(`  [FAIL] ${message}`);
  }
}

// --- 1. 前端脚本语法 ---
const scriptPath = resolve(root, 'media/webview.js');
check(existsSync(scriptPath), 'media/webview.js 已生成');
if (existsSync(scriptPath)) {
  const code = readFileSync(scriptPath, 'utf8');
  try {
    new vm.Script(code, { filename: 'webview.js' });
    check(true, 'media/webview.js 语法合法（可被浏览器解析）');
  } catch (err) {
    check(false, `media/webview.js 语法错误: ${err.message}`);
  }
  try {
    new vm.Script(readFileSync(resolve(root, 'media/webview.css'), 'utf8'));
  } catch {
    /* CSS 不做脚本校验 */
  }
}

// --- 2. 用**真实**的 i18n 与 HTML 生成器渲染（不是手写副本）---
const workDir = mkdtempSync(join(tmpdir(), 'depscan-check-'));
const bundle = async (entry, name) => {
  const outfile = join(workDir, name);
  await build({
    entryPoints: [resolve(root, entry)],
    bundle: true,
    platform: 'node',
    format: 'esm',
    target: 'node18',
    outfile,
    logLevel: 'error'
  });
  return import(pathToFileURL(outfile).href);
};

const htmlMod = await bundle('src/views/webviewHtml.ts', 'webviewHtml.mjs');
const stringsMod = await bundle('src/views/webviewStrings.ts', 'webviewStrings.mjs');
const zhMod = await bundle('src/i18n/zh.ts', 'zh.mjs');
const enMod = await bundle('src/i18n/en.ts', 'en.mjs');

const zhStrings = zhMod.zh;
const enStrings = enMod.en;
const i18n = stringsMod.buildWebviewStrings(zhStrings);
const i18nEn = stringsMod.buildWebviewStrings(enStrings);

const html = htmlMod.renderGraphHtml({
  cspSource: 'vscode-webview://test',
  scriptUri: 'https://file+.vscode-resource.vscode-cdn.net/media/webview.js',
  styleUri: 'https://file+.vscode-resource.vscode-cdn.net/media/webview.css',
  nonce: 'testnonce123',
  lang: 'zh-CN',
  title: 'DepScan 依赖图',
  i18n
});

const htmlEn = htmlMod.renderGraphHtml({
  cspSource: 'vscode-webview://test',
  scriptUri: 'https://file+.vscode-resource.vscode-cdn.net/media/webview.js',
  styleUri: 'https://file+.vscode-resource.vscode-cdn.net/media/webview.css',
  nonce: 'testnonce123',
  lang: 'en',
  title: 'DepScan Dependency Graph',
  i18n: i18nEn
});

// --- 3. 前端脚本引用的元素 id 必须都在 HTML 里 ---
const mainSource = readFileSync(resolve(root, 'webview/main.ts'), 'utf8');
const idPattern = /el(?:<[^>]*>)?\(\s*'([A-Za-z0-9_-]+)'\s*\)/g;
const usedIds = new Set();
let m;
while ((m = idPattern.exec(mainSource)) !== null) usedIds.add(m[1]);
const htmlIds = new Set([...html.matchAll(/id="([^"]+)"/g)].map((x) => x[1]));

const missing = [...usedIds].filter((id) => !htmlIds.has(id));
check(usedIds.size >= 15, `前端引用了 ${usedIds.size} 个 DOM 元素`);
check(missing.length === 0, `所有引用的元素 id 都存在${missing.length ? `（缺失: ${missing.join(', ')}）` : ''}`);

// 反向检查：HTML 里的 anchor/tab 元素不应是死链（无 JS 引用也无害，但至少要有 id 命名空间）
check(
  [...htmlIds].every((id) => /^[A-Za-z][A-Za-z0-9_-]*$/.test(id)),
  'HTML 中的 id 命名合法'
);

// --- 4. 内嵌 i18n JSON 可解析 ---
const embedded = html.match(/<div id="i18n" hidden>([\s\S]*?)<\/div>/);
check(!!embedded, 'HTML 内嵌 i18n 数据块');
if (embedded) {
  try {
    const parsed = JSON.parse(embedded[1]);
    check(typeof parsed === 'object' && parsed !== null && Object.keys(parsed).length > 10, '内嵌 i18n JSON 可解析且非空');
  } catch (err) {
    check(false, `内嵌 i18n JSON 解析失败: ${err.message}`);
  }
}

// --- 5. CSP 与脚本标签 ---
check(html.includes("script-src 'nonce-testnonce123'"), 'CSP 使用 nonce 限制脚本来源');
check(html.includes('<script nonce="testnonce123" src='), '脚本以外部文件 + nonce 加载（无内联脚本）');
check(!/<script(?![^>]*src)[^>]*>[\s\S]*?\S[\s\S]*?<\/script>/.test(html), '不存在含内容的内联 <script>');
check(html.includes('default-src \'none\''), 'CSP 默认拒绝一切外部资源');

// --- 6. 布局回归守卫 ---
// 曾经踩过：DOM 是 4 行（工具栏/页签/内容/状态），CSS 只声明 3 条轨道且不指定 grid-row，
// 自动排布把 1fr 分给了页签行，画布高度塌成 91px（表现为"图缩成底部一个小点"）。
const css = readFileSync(resolve(root, 'media/webview.css'), 'utf8');
const cssBlock = (selector) => {
  const i = css.indexOf(`\n${selector} {`);
  if (i < 0) return '';
  return css.slice(i, css.indexOf('}', i));
};
const appBlock = cssBlock('#app');
const trackSpec = (appBlock.match(/grid-template-rows:\s*([^;]+);/)?.[1] ?? '').trim();
const trackCount = (trackSpec.match(/minmax\([^)]*\)|auto|[\d.]+fr/g) ?? []).length;
check(trackCount === 4, `#app 声明了 4 条网格轨道（工具栏/页签/内容/状态），实际 ${trackCount} 条`);
for (const [selector, row] of [['#toolbar', 1], ['#tabs', 2], ['main', 3], ['aside', 3], ['#status', 4]]) {
  const block = cssBlock(selector);
  check(
    new RegExp(`grid-row:\\s*${row}`).test(block),
    `${selector} 显式指定 grid-row: ${row}（避免自动排布错位）`
  );
}
check(/min-height:\s*0/.test(cssBlock('main')), 'main 设置 min-height: 0（防止内容把网格行撑破）');

// --- 6.1 公开面（V4）：表格 / 树 / 详情 / 图例共用同一个角标 ---
// 判定只在引擎（types.hpp 的 isPublicApiFile），前端只读 apiHeader；
// 画布上刻意**不**画环 —— 大项目里公开面往往是大多数，画上去就是噪声（见 docs/02）。
{
  const bundle = readFileSync(resolve(root, 'media/webview.js'), 'utf8');
  check(/\.badge-api\s*\{/.test(css), '样式里有「公开面」角标 .badge-api');
  check(bundle.includes('badge-api'), '前端用上了这个角标（表格 / 树 / 图例共用）');
  check(bundle.includes('apiHeader'), '前端读的是引擎给的 apiHeader（判定只有一处）');
  check(
    i18n['graph.apiBadge'] === '公开' && i18nEn['graph.apiBadge'] === 'API',
    `角标文案跟随语言且尽量短（${i18n['graph.apiBadge']} / ${i18nEn['graph.apiBadge']}）`
  );
  check(
    /graph\.apiLegend/.test(bundle) || i18n['graph.apiLegend'].includes('include/'),
    '图例里说明公开面的判定依据（声明在 include/ 下）'
  );
}

// --- 7. 中英双语：键集合必须完全一致，且英文字面量真的出现 ---
const flattenKeys = (obj, prefix = '') =>
  Object.entries(obj).flatMap(([k, v]) =>
    v && typeof v === 'object' ? flattenKeys(v, `${prefix}${k}.`) : [`${prefix}${k}`]
  );
const zhKeys = new Set(flattenKeys(zhStrings));
const enKeys = new Set(flattenKeys(enStrings));
const missingInEn = [...zhKeys].filter((k) => !enKeys.has(k));
const missingInZh = [...enKeys].filter((k) => !zhKeys.has(k));
check(zhKeys.size > 60, `中文文案共 ${zhKeys.size} 条`);
check(missingInEn.length === 0, `英文文案无缺键${missingInEn.length ? `（缺 ${missingInEn.join(', ')}）` : ''}`);
check(missingInZh.length === 0, `中文文案无缺键${missingInZh.length ? `（缺 ${missingInZh.join(', ')}）` : ''}`);

const isPlaceholderDump = (arr) => arr.some(([k, v]) => k === v);
check(!isPlaceholderDump(Object.entries(i18n)), '中文 Webview 文案没有"键名当值"的占位残留');
check(!isPlaceholderDump(Object.entries(i18nEn)), '英文 Webview 文案没有"键名当值"的占位残留');
check(i18nEn['graph.viewGraph'] === 'Graph' && i18n['graph.viewGraph'] === '图', '中英文界面文案确实不同');
check(htmlEn.includes('>Graph<') && html.includes('>图<'), '英文/中文 HTML 分别渲染出了对应语言');
check(/<html lang="en"/.test(htmlEn) && /<html lang="zh-CN"/.test(html), '<html lang> 跟随语言切换');
check(
  /id="sel-language"/.test(html) && /value="auto"[\s\S]*value="zh"[\s\S]*value="en"/.test(html),
  '依赖图工具栏内自带语言切换（auto / zh / en）'
);
check(
  /id="sel-language"[\s\S]*?Follow VS Code/.test(htmlEn) && /id="sel-language"[\s\S]*?跟随 VS Code/.test(html),
  '语言下拉的两个选项文案本身也跟随语言'
);

// --- 8. package.nls：默认(英文)与中文翻译的键必须一致，且 package.json 引用的键都存在 ---
const nlsDefault = JSON.parse(readFileSync(resolve(root, 'package.nls.json'), 'utf8'));
const nlsZh = JSON.parse(readFileSync(resolve(root, 'package.nls.zh-cn.json'), 'utf8'));
const nlsKeys = new Set(Object.keys(nlsDefault));
const nlsZhKeys = new Set(Object.keys(nlsZh));
const nlsMissingZh = [...nlsKeys].filter((k) => !nlsZhKeys.has(k));
const nlsExtraZh = [...nlsZhKeys].filter((k) => !nlsKeys.has(k));
check(nlsMissingZh.length === 0, `package.nls.zh-cn.json 无缺键${nlsMissingZh.length ? `（缺 ${nlsMissingZh.join(', ')}）` : ''}`);
check(nlsExtraZh.length === 0, `package.nls.zh-cn.json 无多余键${nlsExtraZh.length ? `（多 ${nlsExtraZh.join(', ')}）` : ''}`);
check(nlsDefault['view.actions'] === 'Actions', 'package.nls.json 是英文默认值（非中文）');

const pkg = JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8'));
const usedNlsKeys = new Set([...JSON.stringify(pkg).matchAll(/%([A-Za-z0-9_.]+)%/g)].map((m) => m[1]));
const danglingKeys = [...usedNlsKeys].filter((k) => !nlsKeys.has(k));
check(usedNlsKeys.size > 20, `package.json 引用了 ${usedNlsKeys.size} 个 nls 键`);
check(danglingKeys.length === 0, `package.json 引用的 nls 键都已定义${danglingKeys.length ? `（缺 ${danglingKeys.join(', ')}）` : ''}`);

// --- 9. 改名守卫：VS Code 可见面（扩展 ID / 命令 / 配置键）不能残留旧前缀 ---
// 名字来回改过（DepScan → DepScaner → 回到 DepScan），踩过的两个坑值得钉住：
//   · codemod 按「depscan.」这种带分隔符的形式替换，于是 `getConfiguration('depscan')`、
//     `affectsConfiguration('depscan')`、`package.json` 的 `"name"` 这类**裸词**全被漏掉 ——
//     表现是设置改了没反应、命令 id 对不上，而编译、类型检查、其它测试全绿；
//   · 反向改回来时，连这个守卫自己都差点被改坏（正则里的旧名字会被替换成新名字，
//     于是它变成「只要用了 depscan. 就报错」）。
// 所以这里把可见面变成可断言的：只要还残留 `depscaner` 就失败。
const OLD_NAME = /depscaner/i;
const tsFiles = [];
(function walk(dir) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name !== 'node_modules') walk(full);
      continue;
    }
    if (entry.name.endsWith('.ts')) tsFiles.push(full);
  }
})(resolve(root, 'src'));

const tsText = tsFiles.map((f) => readFileSync(f, 'utf8')).join('\n');
const oldNameHits = [];
for (const file of tsFiles) {
  readFileSync(file, 'utf8')
    .split('\n')
    .forEach((line, i) => {
      if (OLD_NAME.test(line)) oldNameHits.push(`${relative(root, file)}:${i + 1}`);
    });
}
check(pkg.name === 'depscan', `package.json 的扩展 ID = depscan（实际 ${pkg.name}）`);
check(
  pkg.publisher === 'liivon',
  `publisher = liivon（改了这个就发不到已有商品页上了，实际 ${pkg.publisher}）`
);
check(
  oldNameHits.length === 0,
  `src/ 里没有残留的旧名字 depscaner${oldNameHits.length ? `（${oldNameHits.slice(0, 5).join(', ')}）` : ''}`
);
// package.json / package.nls 也是「可见面」：命令标题、配置描述都在那儿
check(
  !OLD_NAME.test(readFileSync(resolve(root, 'package.json'), 'utf8')),
  'package.json 里没有残留的旧名字'
);
check(
  !OLD_NAME.test(
    readFileSync(resolve(root, 'package.nls.json'), 'utf8') +
      readFileSync(resolve(root, 'package.nls.zh-cn.json'), 'utf8')
  ),
  'package.nls*.json 里没有残留的旧名字'
);

const contributedCommands = new Set((pkg.contributes?.commands ?? []).map((c) => c.command));
const registeredCommands = new Set(
  [...tsText.matchAll(/registerCommand\(\s*'(depscan\.[A-Za-z0-9_.]+)'/g)].map((m) => m[1])
);
const menuCommands = new Set();
for (const list of Object.values(pkg.contributes?.menus ?? {})) {
  for (const item of list) menuCommands.add(item.command);
}
const menuNotRegistered = [...menuCommands].filter((c) => !registeredCommands.has(c));
const menuNotContributed = [...menuCommands].filter((c) => !contributedCommands.has(c));
check(
  [...contributedCommands].every((c) => c.startsWith('depscan.')),
  `contributes.commands 的 ${contributedCommands.size} 个 id 全部以 depscan. 开头`
);
check(
  menuNotContributed.length === 0,
  `菜单引用的命令都在 contributes.commands 里声明过${menuNotContributed.length ? `（缺 ${menuNotContributed.join(', ')}）` : ''}`
);
check(
  menuNotRegistered.length === 0,
  `菜单引用的命令都真的注册了${menuNotRegistered.length ? `（缺 ${menuNotRegistered.join(', ')}）` : ''}`
);

// 配置键：既要前缀对，也要真的被代码读到 —— 「写了配置但代码不读」是改名时最容易留下的坑
const configKeys = Object.keys(pkg.contributes?.configuration?.properties ?? {});
const badPrefix = configKeys.filter((k) => !k.startsWith('depscan.'));
const unreadKeys = configKeys.filter(
  (k) => !tsText.includes(`'${k.replace(/^depscan\./, '')}'`)
);
check(configKeys.length > 10 && badPrefix.length === 0, `配置键全部以 depscan. 开头（${configKeys.length} 个）`);
check(
  unreadKeys.length === 0,
  `每个配置键都在代码里被读到${unreadKeys.length ? `（没人读：${unreadKeys.join(', ')}）` : ''}`
);

// --- 10. 图标守卫：两个产物都是 `npm run icon` 用代码画的，且满足平台硬性要求 ---
// 为什么值得断言：图标是**二进制**，改错了没有任何编译/类型检查会提醒你；
// 而 Marketplace 对 PNG 的尺寸、活动栏图标对「单色 + currentColor」都有硬要求，
// 违反了分别表现为「发布被拒」和「深色主题下看不见」——两种都很难在本地发现。
{
  const iconPath = resolve(root, 'media/icon.png');
  const svgPath = resolve(root, 'media/activitybar.svg');
  check(existsSync(iconPath), 'media/icon.png 存在（npm run icon 生成）');
  if (existsSync(iconPath)) {
    const png = readFileSync(iconPath);
    const magic = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    check(png.subarray(0, 8).equals(magic), 'media/icon.png 是合法 PNG（魔数正确）');
    check(png.subarray(12, 16).toString('ascii') === 'IHDR', 'media/icon.png 第一个块是 IHDR');
    const w = png.readUInt32BE(16);
    const h = png.readUInt32BE(20);
    check(w === 128 && h === 128, `扩展图标 ${w}x${h}（VS Code / Marketplace 要求 128x128）`);
    check(png[25] === 6, '扩展图标是 RGBA（圆角外要透明，不能糊成白底方图）');
  }

  check(existsSync(svgPath), 'media/activitybar.svg 存在（npm run icon 生成）');
  if (existsSync(svgPath)) {
    const svg = readFileSync(svgPath, 'utf8');
    check(/viewBox="0 0 24 24"/.test(svg), '活动栏图标 viewBox 24x24（VS Code 规定的活动栏图标尺寸）');
    check(svg.includes('currentColor'), '活动栏图标用 currentColor（跟随主题，深浅色都看得见）');
    check(
      !/#[0-9a-fA-F]{3,6}\b/.test(svg) && !/fill="(?!none|currentColor)/.test(svg),
      '活动栏图标不写死颜色（写死颜色在深色/浅色主题下必有一边看不见）'
    );
    check(/<path /.test(svg), '活动栏图标有蛋白轮廓（不规则 path，不是正圆）');
    check(/<circle [^>]*fill="currentColor"/.test(svg), '活动栏图标有蛋黄（实心圆）');
  }

  check(pkg.icon === 'media/icon.png', 'package.json 的扩展图标指向生成的 PNG');
  const containers = pkg.contributes?.viewsContainers?.activitybar ?? [];
  check(
    containers.length === 1 && containers[0].icon === 'media/activitybar.svg',
    '活动栏容器只有一个且用生成的 SVG（多一个容器就会多一个侧边栏图标）'
  );
  check(
    (pkg.contributes?.views?.[containers[0]?.id] ?? []).every((v) => v.icon === 'media/activitybar.svg'),
    '侧边栏视图的图标同样来自生成产物（没有手改的旧图标残留）'
  );
  check(pkg.scripts?.icon === 'node scripts/make-icon.mjs', '图标由脚本生成（npm run icon），不手工改二进制');
}

rmSync(workDir, { recursive: true, force: true });

if (failures.length > 0) {
  console.error(`\nWebview 自检失败：${failures.length} 项`);
  process.exit(1);
}
console.log('\nWebview 自检通过');
