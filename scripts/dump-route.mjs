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
import { spawn } from 'child_process';
import { createInterface } from 'readline';
import { existsSync, mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { dirname, join, resolve } from 'path';
import { fileURLToPath } from 'url';

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

  const route = await request('route', {
    from,
    strategy: args.dfs ? 'dfs' : 'bfs',
    groupByFile: !!args.files,
    maxDepth: Number(args.depth ?? 6),
    maxSteps: Number(args.steps ?? 200)
  });

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
    console.log(
      `${String(step.order).padStart(pad)} ${'  '.repeat(depth)}${step.name}${mark}` +
        `\t${step.file}:${step.line}`
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
    route.truncated
      ? `未展开：${route.frontierNodes} 个节点 / ${route.frontierFiles} 个文件（到达步数或深度上限）`
      : '路线已完整生成'
  );
  const ambiguous = route.steps.filter((s) => s.ambiguous).length;
  console.log(`同名定义候选：${ambiguous} / ${route.steps.length} 步存在「可能是错边」的情况`);
} catch (err) {
  console.error(`[dump-route] 失败: ${err.message}`);
  process.exitCode = 1;
} finally {
  rl.close();
  child.kill();
  rmSync(cacheDir, { recursive: true, force: true });
}
