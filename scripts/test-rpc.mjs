// 协议冒烟测试：以「真实子进程 + 逐行 JSON-RPC」的方式驱动引擎，
// 覆盖插件实际会用到的全部方法（这是最容易出问题的跨语言链路）。
import { spawn } from 'child_process';
import { createInterface } from 'readline';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { dirname, join, resolve } from 'path';
import { fileURLToPath } from 'url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const exe = process.platform === 'win32' ? '.exe' : '';
const CANDIDATES = [
  `engine/build/bin/Release/depscan-core${exe}`,
  `engine/build/bin/RelWithDebInfo/depscan-core${exe}`,
  `engine/build/bin/Debug/depscan-core${exe}`,
  `engine/build/bin/depscan-core${exe}`
];

const enginePath = CANDIDATES.map((p) => resolve(root, p)).find((p) => existsSync(p));
if (!enginePath) {
  console.error('[test-rpc] 未找到引擎，请先 npm run build:core');
  process.exit(1);
}

const failures = [];
let passed = 0;
function check(condition, message) {
  if (condition) {
    passed += 1;
    console.log(`  [PASS] ${message}`);
  } else {
    failures.push(message);
    console.log(`  [FAIL] ${message}`);
  }
}

const cacheDir = mkdtempSync(join(tmpdir(), 'depscan-rpc-'));
const child = spawn(enginePath, [], { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
const rl = createInterface({ input: child.stdout });

let nextId = 1;
const pending = new Map();
let progressCount = 0;

rl.on('line', (line) => {
  const text = line.trim();
  if (!text) return;
  let msg;
  try {
    msg = JSON.parse(text);
  } catch (err) {
    console.error(`[test-rpc] 引擎输出非法 JSON: ${text.slice(0, 120)}`);
    failures.push('引擎输出必须每行一个合法 JSON');
    return;
  }
  if (msg.method === 'progress') {
    progressCount += 1;
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
  if (text) console.log(`  [engine] ${text}`);
});

function request(method, params = {}) {
  const id = nextId++;
  child.stdin.write(`${JSON.stringify({ id, method, params })}\n`);
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      pending.delete(id);
      reject(new Error(`请求超时: ${method}`));
    }, 120000);
    pending.set(id, {
      resolve: (v) => {
        clearTimeout(timer);
        resolve(v);
      },
      reject: (e) => {
        clearTimeout(timer);
        reject(e);
      }
    });
  });
}

const demoRoot = resolve(root, 'samples/demo');

// 开发机可能已经为 demo 生成过编译数据库（比如换成 Ninja 生成器后）。
// 这条断言只关心「引擎有没有如实报告」，不把 fixture 状态写死，
// 否则本地一生成 compile_commands.json，测试就会假失败。
const demoCompileDb = [
  'compile_commands.json',
  'build/compile_commands.json',
  'build-ninja/compile_commands.json',
  'out/compile_commands.json'
]
  .map((p) => join(demoRoot, p))
  .find((p) => existsSync(p));

const config = {
  includes: true,
  calls: true,
  types: true,
  symbols: true,
  links: true,
  includeExternal: true,
  cachePath: join(cacheDir, 'index-v1.txt'),
  useCache: true,
  excludeGlobs: ['**/build/**', '**/.git/**']
};

try {
  const ping = await request('ping');
  check(ping.pong === true && ping.protocol === 1, `ping 返回协议版本 ${ping.protocol}，引擎 v${ping.version}`);

  const stats = await request('scan', { root: demoRoot, config });
  check(stats.fileCount >= 10, `scan 覆盖 ${stats.fileCount} 个文件`);
  check(progressCount > 0, `收到 ${progressCount} 条 progress 通知（索引进度可用）`);
  const kinds = stats.edgeKindCounts ?? {};
  check((kinds.includes ?? 0) > 0, `includes 边 ${kinds.includes ?? 0} 条`);
  check((kinds.calls ?? 0) > 0, `calls 边 ${kinds.calls ?? 0} 条`);
  check((kinds.inherits ?? 0) > 0, `inherits 边 ${kinds.inherits ?? 0} 条`);
  check((kinds.uses ?? 0) > 0, `uses 边 ${kinds.uses ?? 0} 条`);
  check((kinds.links ?? 0) > 0, `links 边 ${kinds.links ?? 0} 条`);
  check(stats.compileCommandsFound === !!demoCompileDb,
    demoCompileDb
      ? '发现了 demo 内的编译数据库，精度随之提升（partial/exact）'
      : '无 compile_commands.json 时如实标记（精度降级）');

  const sub = await request('subgraph', {
    focus: 'file:src/core/engine.cpp',
    depth: 2,
    direction: 'both',
    maxNodes: 500
  });
  check(sub.graph.nodes.length >= 3, `子图返回 ${sub.graph.nodes.length} 个节点 / ${sub.graph.edges.length} 条边`);

  const upstream = await request('subgraph', {
    focus: 'file:src/util/logger.h',
    depth: 1,
    direction: 'upstream',
    maxNodes: 200
  });
  check(upstream.graph.nodes.length >= 3, `upstream 方向查询可用（${upstream.graph.nodes.length} 节点）`);

  const symbol = await request('symbolGraph', {
    file: 'src/core/engine.cpp',
    line: 8,
    depth: 2,
    direction: 'both',
    maxNodes: 300
  });
  check(typeof symbol.focus === 'string' && symbol.focus.length > 0, `符号级焦点定位成功: ${symbol.focus}`);

  const arch = await request('architecture', { maxNodes: 50 });
  check(arch.graph.nodes.length > 0, `全局架构视图返回 ${arch.graph.nodes.length} 个目录节点`);

  for (const format of ['json', 'dot', 'mermaid']) {
    const exp = await request('exportData', { format, depth: 2, maxNodes: 300 });
    check(typeof exp.content === 'string' && exp.content.length > 20, `导出 ${format} 成功（${exp.content.length} 字节）`);
  }

  const updated = await request('updateFile', { file: 'src/core/engine.cpp', config });
  check(updated.updated === true, '增量更新单个文件成功（保存事件路径）');

  const dependents = await request('dependents', { file: 'src/util/logger.h' });
  check(Array.isArray(dependents.dependents) && dependents.dependents.length > 0,
    `可计算受影响文件：${dependents.dependents.length} 个`);

  const cancelled = await request('cancel');
  check(cancelled.cancelled === true, '取消指令被接受');

  // --- 精确解析路径：临时提供 compile_commands.json，验证精度分级真的生效 ---
  const compdbPath = join(demoRoot, 'compile_commands.json');
  const entries = [
    'src/main.cpp',
    'src/app/application.cpp',
    'src/core/engine.cpp',
    'src/core/registry.cpp',
    'src/ui/panel.cpp',
    'src/util/logger.cpp',
    'src/util/string_utils.cpp'
  ].map((file) => ({
    directory: demoRoot,
    file,
    arguments: ['clang++', '-std=c++17', '-Iinclude', '-Isrc', '-DDEMO_BUILD=1', '-c', file]
  }));
  writeFileSync(compdbPath, JSON.stringify(entries, null, 2));
  try {
    const exactStats = await request('scan', {
      root: demoRoot,
      config: { ...config, forceFull: true, cachePath: '' }
    });
    check(exactStats.compileCommandsFound === true, '自动发现 compile_commands.json');
    check(exactStats.compileCommandEntries === entries.length,
      `解析出 ${exactStats.compileCommandEntries} 条编译命令`);
    check(exactStats.exactIncludeEdges > 0,
      `include 精确解析生效（exact ${exactStats.exactIncludeEdges} 条 / approx ${exactStats.approxIncludeEdges} 条）`);
    check(exactStats.exactNodes > exactStats.approxNodes || exactStats.exactIncludeEdges > 5,
      '精度等级随编译数据库提升');

    // 缓存指纹必须包含编译数据库：否则「先扫描、后生成 compile_commands.json」
    // 会一直命中旧缓存，用户编译完刷新仍看到「近似」。这正是线上反馈的 bug。
    const inflated = await request('scan', { root: demoRoot, config: { ...config } });
    check(inflated.cacheReused === false, '编译数据库新增后旧缓存被丢弃（不再复用）');
    check(inflated.exactIncludeEdges > 0,
      `丢弃缓存后重新解析，include 仍为精确（${inflated.exactIncludeEdges} 条）`);
    check((inflated.warnings ?? []).some((w) => w.includes('缓存')),
      '给出「旧缓存已丢弃并重新解析」的提示');

    // 参数完全没变时，缓存应该照常复用（避免每次全量重解析）
    const warm = await request('scan', { root: demoRoot, config: { ...config } });
    check(warm.cacheReused === true, '编译参数未变化时复用磁盘缓存');
    check(warm.precision === inflated.precision,
      `复用缓存后精度保持一致（${warm.precision}）`);
  } finally {
    rmSync(compdbPath, { force: true });
  }

  const bye = await request('shutdown');
  check(bye.bye === true, 'shutdown 正常响应');
} catch (err) {
  failures.push(`异常：${err.message}`);
  console.error(`[test-rpc] ${err.message}`);
} finally {
  child.kill();
  rmSync(cacheDir, { recursive: true, force: true });
}

if (failures.length > 0) {
  console.error(`\n[test-rpc] 失败 ${failures.length} 项 / 通过 ${passed} 项`);
  process.exit(1);
}
console.log(`\n[test-rpc] 全部通过（${passed} 项）`);
