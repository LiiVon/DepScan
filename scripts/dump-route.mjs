// 把「阅读路线」按树打印到终端。
//
// 为什么要有这个脚本：路线的**顺序**是核心信息，而它的验收方式是「读起来合不合理」。
// UI 里看一眼当然更直观，但文档里要贴的路线清单、以及「改了消解逻辑之后顺序有没有变」
// 这件事，都需要一个不看 UI 就能复现的出口。
//
// 用法：
//   node scripts/dump-route.mjs                     # demo，从自动识别的入口出发
//   node scripts/dump-route.mjs --dfs --files        # 深度优先 + 文件级
//   node scripts/dump-route.mjs --file src/core/engine.cpp --line 29   # 从光标处出发
//   node scripts/dump-route.mjs --from func:demo::Engine::run
//   node scripts/dump-route.mjs --svg  out.svg       # 顺便导出泳道图（不打开 VS Code 也能看图）
//   node scripts/dump-route.mjs --trim               # 开降噪：折叠「短且只调一处」的琐碎步骤
//   node scripts/dump-route.mjs --entries            # 起点候选（库项目没有 main 时尤其有用）
//   node scripts/dump-route.mjs --root samples/libdemo --entries   # 库项目：从候选里挑一个起点
//   node scripts/dump-route.mjs --layers             # 按层打印（大项目下先看摘要的那种看法）
//   node scripts/dump-route.mjs --layers --all        # 层视图：连被分页藏起来的一起列出
//   node scripts/dump-route.mjs --html               # 生成泳道图**页面**的离线预览
//
// `--svg` 让这张图有一个**不经 UI** 的出口：既能直接丢进浏览器核对，
// 也方便把它贴进 issue / 文档。导出用的与面板里显示的是同一对纯函数。
//
// `--html` 更进一步：把真实页面（真实 HTML 生成器 + 真实文案 + 真实前端脚本）
// 拿去浏览器里跑，并**用 postMessage 投递数据** —— 也就是真正走一遍面板的链路。
// Webview 的问题只能在浏览器里才暴露（这个项目已经踩过一次「打开一片空白」），
// 所以这一条是唯一能替代 F5 的验证手段。
import { spawn } from 'child_process';
import { build } from 'esbuild';
import { createInterface } from 'readline';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { dirname, join, resolve } from 'path';
import { fileURLToPath, pathToFileURL } from 'url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const exe = process.platform === 'win32' ? '.exe' : '';
const enginePath = [
  `engine/build/bin/Release/depscan-core${exe}`,
  `engine/build/bin/RelWithDebInfo/depscan-core${exe}`,
  `engine/build/bin/Debug/depscan-core${exe}`,
  `engine/build/bin/depscan-core${exe}`
]
  .map((p) => resolve(root, p))
  .find((p) => existsSync(p));

if (!enginePath) {
  console.error('[dump-route] 未找到引擎，请先 npm run build:core');
  process.exit(1);
}

/** 极简参数解析：--k v / --flag */
function parseArgs(argv) {
  const out = { flags: new Set() };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (!a.startsWith('--')) continue;
    const key = a.slice(2);
    const next = argv[i + 1];
    if (next === undefined || next.startsWith('--')) {
      out.flags.add(key);
    } else {
      out[key] = next;
      i += 1;
    }
  }
  return out;
}

const args = parseArgs(process.argv.slice(2));
const projectRoot = resolve(root, args.root ?? 'samples/demo');

const child = spawn(enginePath, [], { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
const rl = createInterface({ input: child.stdout });
let nextId = 1;
const pending = new Map();
let progress = null;

rl.on('line', (line) => {
  const text = line.trim();
  if (!text) return;
  let msg;
  try {
    msg = JSON.parse(text);
  } catch {
    console.error(`[dump-route] 引擎输出非法 JSON: ${text.slice(0, 160)}`);
    return;
  }
  if (msg.method === 'progress') {
    progress = msg.params;
    return;
  }
  const call = pending.get(msg.id);
  if (!call) return;
  pending.delete(msg.id);
  if (msg.ok) call.resolve(msg.result);
  else call.reject(new Error(msg.error?.message ?? 'unknown'));
});
child.stderr.on('data', (chunk) => {
  const text = chunk.toString('utf8').trim();
  if (text) console.error(`  [engine] ${text}`);
});

function request(method, params = {}) {
  const id = nextId++;
  child.stdin.write(`${JSON.stringify({ id, method, params })}\n`);
  return new Promise((resolve_, reject) => {
    const timer = setTimeout(() => {
      pending.delete(id);
      reject(new Error(`请求超时: ${method}`));
    }, 120000);
    pending.set(id, {
      resolve: (v) => {
        clearTimeout(timer);
        resolve_(v);
      },
      reject: (e) => {
        clearTimeout(timer);
        reject(e);
      }
    });
  });
}

const cacheDir = mkdtempSync(join(tmpdir(), 'depscan-dump-'));

try {
  await request('scan', {
    root: projectRoot,
    config: {
      cachePath: join(cacheDir, 'index-v1.txt'),
      useCache: false,
      excludeGlobs: ['**/build/**', '**/build-*/**', '**/out/**', '**/CMakeFiles/**', '**/.git/**', '**/_deps/**']
    }
  });
  if (progress) console.error(`[dump-route] 已索引 ${progress.total ?? '?'} 个文件`);

  let from = args.from ?? '';
  if (!from && args.file) {
    // 模拟编辑器里的「从这里开始读」：光标位置 → 所在函数
    const at = await request('nodeAt', {
      file: args.file,
      line: Number(args.line ?? 1)
    });
    from = at.id;
    console.error(`[dump-route] 光标 ${args.file}:${args.line ?? 1} → ${at.id}`);
  }

  let route;
  try {
    route = await request('route', {
      from,
      strategy: args.dfs ? 'dfs' : 'bfs',
      groupByFile: !!args.files,
      skipTrivial: args.flags.has('trim'),
      maxDepth: Number(args.depth ?? 6),
      maxSteps: Number(args.steps ?? 200)
    });
  } catch (err) {
    // 库项目（没有 main）走到这里就会失败 —— 而 `--entries` 恰恰就是要看这种情况，
    // 所以只吞掉这个错误，把候选列出来（其他情况照旧抛出去）。
    if (!args.flags.has('entries')) throw err;
    console.log(`路线生成失败：${err.message}`);
    route = {
      from: '',
      steps: [],
      truncated: false,
      frontierNodes: 0,
      frontierFiles: 0,
      maxReachedDepth: 0,
      skippedCount: 0
    };
  }

  const byOrder = new Map(route.steps.map((s) => [s.order, s]));
  const kids = new Map();
  for (const s of route.steps) {
    if (s.parent === 0) continue;
    if (!kids.has(s.parent)) kids.set(s.parent, []);
    kids.get(s.parent).push(s);
  }

  console.log(`起点：${route.from}`);
  console.log(
    `策略：${args.dfs ? 'dfs' : 'bfs'}　粒度：${args.files ? '文件级' : '函数级'}　` +
      `步数：${route.steps.length}　最深层数：${route.maxReachedDepth}`
  );
  console.log('');

  const pad = String(route.steps.length).length;
  const walk = (step, depth) => {
    const mark = step.ambiguous ? ' ⚠' : step.newFile ? ' ·' : '';
    const size = step.bodyLines > 0 ? ` <${step.bodyLines}行>` : '';
    const api = step.apiHeader ? '〔公开接口〕' : '';
    const skipped = step.skipped?.length ? `〔跳过：${step.skipped.join('、')}〕` : '';
    console.log(
      `${String(step.order).padStart(pad)} ${'  '.repeat(depth)}${step.name}${mark}${size}${api}` +
        `\t${step.file}:${step.line}${skipped}`
    );
    if (step.ambiguous) {
      for (const c of step.candidates ?? []) {
        console.log(`${' '.repeat(pad + 1)} ${'  '.repeat(depth + 1)}└ 候选：${c.id}（${c.file}:${c.line}）`);
      }
      if (step.candidateTotal > (step.candidates?.length ?? 0)) {
        console.log(
          `${' '.repeat(pad + 1)} ${'  '.repeat(depth + 1)}└ 另有 ${step.candidateTotal - step.candidates.length} 处同名定义未列出`
        );
      }
    }
    for (const k of kids.get(step.order) ?? []) walk(k, depth + 1);
  };
  for (const s of route.steps.filter((x) => x.parent === 0)) walk(s, 0);

  console.log('');
  console.log(
    route.steps.length === 0
      ? '还没有起点 —— 库项目没有 main 是正常的，先看 --entries 给出的候选'
      : route.truncated
        ? `未展开：${route.frontierNodes} 个节点 / ${route.frontierFiles} 个文件（到达步数或深度上限）`
        : '路线已完整生成'
  );
  const ambiguous = route.steps.filter((s) => s.ambiguous).length;
  console.log(`同名定义候选：${ambiguous} / ${route.steps.length} 步存在「可能是错边」的情况`);
  if (route.skippedCount > 0) {
    console.log(`降噪折叠：${route.skippedCount} 个琐碎步骤（跳过的不删掉，列在各自的父步骤后面）`);
  }

  if (args.flags.has('entries')) {
    // 起点候选：main 优先，其次是库的公开接口与调用图上的「根」。
    // 引擎不猜起点（挑错了整条顺序都是错的），所以这里把候选摆出来让人自己定。
    const ent = await request('entries', { limit: 0 });
    const tag = (c) => (c.mainLike ? '程序入口' : c.publicApi ? '公开接口' : '调用图根');
    console.log('');
    console.log(`起点候选（共 ${ent.total} 个，有 main：${ent.hasMain ? '是' : '否'}）：`);
    for (const c of ent.candidates) {
      console.log(
        `  [${tag(c)}] ${c.name}\t${c.file}:${c.line}` +
          `\t调用者 ${c.callers} / 下游 ${c.callees}` +
          (c.apiHeader ? `\t公开声明 ${c.apiHeader}:${c.apiLine}` : '')
      );
    }
  }

  // 需要 TS 纯函数时现打一份（与离线自检脚本同一套路）——
  // 打印的一定是**界面用的那个函数**，否则文档里的清单会和 UI 悄悄漂移
  const bundleModule = async (entry, name) => {
    const outfile = join(tmpdir(), `depscan-swimlane-${name}-${Date.now()}.mjs`);
    await build({
      entryPoints: [resolve(root, entry)],
      bundle: true,
      platform: 'node',
      format: 'esm',
      target: 'node18',
      outfile,
      logLevel: 'error'
    });
    return { mod: await import(pathToFileURL(outfile).href), outfile };
  };

  if (args.flags.has('layers')) {
    const model = await bundleModule('src/views/routeTreeModel.ts', 'model');
    const tree = model.mod.buildRouteTree(route);
    const none = new Map();
    console.log('');
    console.log('层视图（--layers）：');
    for (const row of model.mod.layerChildren(tree, undefined, none)) {
      if (row.kind === 'tail') {
        console.log(`  ${row.text}`);
        continue;
      }
      if (row.kind !== 'layer') continue;
      console.log(`  ${row.text}${row.defaultExpanded ? '' : '〔超过一页，默认收起〕'}`);
      if (!row.defaultExpanded && !args.flags.has('all')) {
        console.log('     （想在这一层里全看就再加 --all）');
        continue;
      }
      for (const child of model.mod.layerChildren(tree, row, none)) {
        if (child.kind === 'step') {
          console.log(
            `    ${String(child.step.order).padStart(pad)} ${child.step.name}\t` +
              `${child.step.file}:${child.step.line}`
          );
        } else if (child.kind === 'more') {
          console.log(`    ${child.text}`);
        }
      }
    }
    rmSync(model.outfile, { force: true });
  }

  if (args.svg !== undefined || args.flags.has('svg') || args.flags.has('html')) {
    const swim = await bundleModule('src/views/swimlane.ts', 'layout');
    const layout = swim.mod.layoutSwimlane(route, { maxSteps: 400 });
    const svg = swim.mod.renderSwimlaneSvg(layout);
    rmSync(swim.outfile, { recursive: true, force: true });

    if (args.svg !== undefined || args.flags.has('svg')) {
      const out = resolve(root, args.svg ?? 'engine/build/route-swimlane.svg');
      writeFileSync(out, svg, 'utf8');
      console.log(
        `\n泳道图已写入：${out}` +
          `（${layout.stepCount} 步 / ${layout.lanes.length} 个文件 / ${layout.crossFileEdges} 次换文件）`
      );
    }

    if (args.html !== undefined || args.flags.has('html')) {
      const htmlMod = await bundleModule('src/views/swimlaneHtml.ts', 'html');
      const strings = await bundleModule('src/views/webviewStrings.ts', 'strings');
      const zhMod = await bundleModule('src/i18n/zh.ts', 'zh');
      const modelMod = await bundleModule('src/views/routeTreeModel.ts', 'model');
      const i18n = strings.mod.buildSwimlaneStrings(zhMod.mod.zh);
      // 标题用生产代码里的同一个函数，别让预览页与面板显示得不一样
      const title = zhMod.mod.zh.route.diagramTitle(modelMod.mod.startLabel(route.from));
      const status = `${layout.stepCount} 步 · ${layout.lanes.length} 个文件 · ${layout.crossFileEdges} 次换文件`;
      let html = htmlMod.mod.renderSwimlaneHtml({
        cspSource: "'self'",
        scriptUri: '../../media/swimlane.js',
        nonce: 'preview',
        lang: 'zh-CN',
        title,
        status,
        svg: undefined, // 故意**不内联**：让数据走 postMessage，与面板里完全同一条链路
        emptyText: '（预览：等待 render 消息）',
        i18n
      });
      // 预览页：去掉 CSP、打桩 vscode api，然后在末尾投递真实的 svg 消息
      html = html.replace(/<meta http-equiv="Content-Security-Policy"[^>]*>\s*/, '');
      html = html.replace(
        '<script nonce="preview"',
        `<script>window.acquireVsCodeApi=function(){return{postMessage:function(m){(window.__posted=window.__posted||[]).push(m);},getState:function(){},setState:function(){}};};</script>\n<script nonce="preview"`
      );
      const payload = JSON.stringify({ type: 'svg', svg, title, status });
      html = html.replace(
        '</body>',
        `<script>window.postMessage(${payload}, '*');</script>\n</body>`
      );
      const out = resolve(root, args.html ?? 'engine/build/route-swimlane.html');
      writeFileSync(out, html, 'utf8');
      console.log(`泳道图页面预览已写入：${out}`);
    }
  }
} catch (err) {
  console.error(`[dump-route] 失败: ${err.message}`);
  process.exitCode = 1;
} finally {
  rl.close();
  child.kill();
  rmSync(cacheDir, { recursive: true, force: true });
}
