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
  `engine/build/bin/Release/depscaner-core${exe}`,
  `engine/build/bin/RelWithDebInfo/depscaner-core${exe}`,
  `engine/build/bin/Debug/depscaner-core${exe}`,
  `engine/build/bin/depscaner-core${exe}`
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

const cacheDir = mkdtempSync(join(tmpdir(), 'depscaner-rpc-'));
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
  // 与插件/引擎的默认排除保持一致：只排 **/build/** 是不够的，
  // 开发者本地可能有 build-ninja / build-debug（含 CMakeFiles 里的探测源码），
  // 否则测试会因为「本机多了一个构建目录」而出现莫名其妙的计数漂移。
  excludeGlobs: [
    '**/build/**',
    '**/build-*/**',
    '**/out/**',
    '**/CMakeFiles/**',
    '**/.git/**',
    '**/_deps/**'
  ]
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

  // --- 阅读路线（route）：从入口出发的**有序**阅读清单 ---
  // 这是本功能唯一的自动化验收方式：不给「好看不好看」下断言，
  // 只给「顺序对不对」下断言 —— 从 main 出发必须按调用链顺序经过这几个函数。
  const route = await request('route', { from: '', strategy: 'bfs', maxDepth: 4, maxSteps: 80 });
  check(route.from === 'func:main', `自动识别程序入口：${route.from}`);
  check(route.steps.length > 3, `路线生成 ${route.steps.length} 步`);
  check(route.steps[0].order === 1 && route.steps[0].parent === 0,
    `第 1 步是起点且没有父节点（${route.steps[0].name}）`);
  {
    // 断言用 id 而不是 name：Node.name 是简单名（start / run / add），
    // 只有 id 带完整限定名，才能确定命中「哪个 start」。
    const ids = route.steps.map((s) => s.id);
    const iStart = ids.findIndex((x) => x.endsWith('::Application::start'));
    const iRun = ids.findIndex((x) => x.endsWith('::Engine::run'));
    const iAdd = ids.findIndex((x) => x.endsWith('::Registry::add'));
    check(
      iStart >= 0 && iRun > iStart && iAdd > iRun,
      `打靶：main → Application::start(#${iStart + 1}) → Engine::run(#${iRun + 1}) → Registry::add(#${iAdd + 1})`
    );
  }
  check(route.steps.every((s) => !s.external), 'projectOnly 生效：路线里不含项目外符号');
  check(route.steps.every((s) => s.name && s.file), '每一步都带符号名与文件位置（可点击跳转）');
  check(
    route.steps.every((s) => Number.isInteger(s.bodyLines) && s.bodyLines >= 0),
    '每一步都带函数体行数（0 = 只有声明 / 不是函数）'
  );
  // 位置必须指向**定义**，而不是这个符号第一次出现的地方。
  // 曾经的 bug：合并符号时先改 declaration、再判断要不要搬位置，于是条件恒为假 ——
  // “先见到声明（甚至只是调用点）、后见到定义”的函数，位置永远停在前一处，
  // 表现就是点一步跳到调用点上去（读代码的人当然想落在定义上）。
  // demo 里的样本：setVerbose 在 src/main.cpp:9 被调用，定义在 src/util/logger.cpp:14。
  {
    const setVerbose = route.steps.find((s) => s.name === 'setVerbose');
    check(
      !!setVerbose && setVerbose.file === 'src/util/logger.cpp' && setVerbose.line === 14,
      `有定义的函数定位到定义处：setVerbose → ${setVerbose?.file}:${setVerbose?.line}` +
        '（曾经停在调用点 src/main.cpp:9）'
    );
    check(
      (setVerbose?.bodyLines ?? 0) > 0,
      `定义处能算出函数体行数：${setVerbose?.bodyLines} 行（声明处只能是 0）`
    );
  }

  // 公开面：路线步骤要能看出「这一步是公开接口」（声明落在 include/ 这类目录里）。
  // 判定完全在引擎侧（types.hpp 的 isPublicApiFile），插件只负责显示。
  {
    const configStep = route.steps.find((s) => s.name === 'config');
    check(
      !!configStep && configStep.apiHeader === 'include/demo/config.h' && configStep.apiLine > 0,
      `路线步骤带公开面：config → ${configStep?.apiHeader}:${configStep?.apiLine}`
    );
    // 公开面看的是「**声明**在哪」，不是「定义在哪」—— 公开接口定义在 src/ 里很正常
    const runStepInRoute = route.steps.find((s) => s.name === 'run');
    check(
      !!runStepInRoute && !runStepInRoute.apiHeader,
      `${runStepInRoute?.name} 声明在 src/core/engine.h，不该被标成公开接口`
    );
  }

  // 层视图（插件侧按 `depth` 分组）靠这条不变量：非起点步骤的深度 = 父步骤深度 + 1。
  // 它同时也是 BFS 距离 —— 层号就是 depth + 1。不成立的话层视图会漏层或错层。
  check(
    route.steps
      .filter((s) => s.parent !== 0)
      .every((s) => {
        const parent = route.steps.find((x) => x.order === s.parent);
        return !!parent && s.depth === parent.depth + 1;
      }),
    '深度与父子关系一致（非起点步骤 depth = 父步骤 depth + 1）—— 层视图分组靠它'
  );
  check(
    route.steps.filter((s) => s.depth === 0).length === 1 &&
      route.steps.find((s) => s.depth === 0).order === 1,
    '只有起点在第 1 层（否则「第 1 层」就不是起点了）'
  );

  const grouped = await request('route', {
    from: '',
    strategy: 'bfs',
    maxDepth: 4,
    maxSteps: 80,
    groupByFile: true
  });
  check(
    grouped.steps.length > 0 && grouped.steps.length < route.steps.length,
    `按文件折叠：${route.steps.length} 步 → ${grouped.steps.length} 步`
  );
  check(grouped.steps.every((s) => s.newFile), '折叠后每一步都是「首次进入某文件」');
  check(grouped.steps[0].parent === 0, '折叠后仍然只有一个根');

  // --- V3：降噪（折叠「纯转发 / 小函数」）---
  // 两个条件同时满足才折叠：函数体不超过 3 行、且只调一处（getter / 纯转发）。
  // 折叠**不是删除**：名字挂到最近的那个保留步骤上，并统计在 skippedCount 里 ——
  // “静默消失”是这类功能最容易犯的错（用户会以为工具漏了这处调用）。
  const trimmed = await request('route', {
    from: '',
    strategy: 'bfs',
    maxDepth: 4,
    maxSteps: 80,
    skipTrivial: true
  });
  check(
    trimmed.steps.length > 0 && trimmed.steps.length < route.steps.length,
    `降噪折叠琐碎步骤：${route.steps.length} 步 → ${trimmed.steps.length} 步`
  );
  {
    const kept = new Set(trimmed.steps.map((s) => s.id));
    const dropped = route.steps.filter((s) => !kept.has(s.id));
    const reported = trimmed.steps.flatMap((s) => s.skipped ?? []);
    check(
      dropped.length > 0 && dropped.every((s) => reported.includes(s.name)),
      `被折叠的步骤如实列在某个保留步骤的 skipped 里：${reported.join('、')}（不是静默删掉）`
    );
    check(
      trimmed.skippedCount === reported.length,
      `skippedCount(${trimmed.skippedCount}) 与 skipped 列表长度(${reported.length})一致`
    );
    check(
      dropped.length > 0 && dropped.every((s) => s.bodyLines > 0 && s.bodyLines <= 3),
      `只折叠「小函数」：被折叠的最大 ${Math.max(0, ...dropped.map((s) => s.bodyLines))} 行`
    );
    check(trimmed.steps[0].id === route.steps[0].id, '起点永不被折叠（起手那一步不该被藏掉）');
    const tid = trimmed.steps.map((s) => s.id);
    const iRun = tid.findIndex((x) => x.endsWith('::Engine::run'));
    const iAdd = tid.findIndex((x) => x.endsWith('::Registry::add'));
    check(iRun >= 0 && iAdd > iRun, '降噪不会把打靶链（Engine::run → Registry::add）拆断');
    // 反例：3 行但调了两处（join / split）—— 它不是纯转发，必须留下
    const describeStep = route.steps.find((s) => s.id === 'func:demo::Engine::describe');
    check(
      !!describeStep && kept.has(describeStep.id),
      '只调一处才算琐碎：Engine::describe 虽然只有 3 行，但它调了 join / split 两处，必须保留'
    );
    check(
      trimmed.steps.slice(1).every((s) => s.parent >= 1 && s.parent !== s.order && tid[s.parent - 1]),
      '折叠后不会留下悬空的父步骤（parent 一定指向另一个真实步骤）'
    );
    const again = await request('route', {
      from: '',
      strategy: 'bfs',
      maxDepth: 4,
      maxSteps: 80,
      skipTrivial: true
    });
    check(
      again.steps.map((s) => s.id).join('>') === trimmed.steps.map((s) => s.id).join('>'),
      '降噪结果是确定的（同样参数下折叠集合不变，否则「打靶」断言写不了）'
    );
    const off = await request('route', {
      from: '',
      strategy: 'bfs',
      maxDepth: 4,
      maxSteps: 80,
      skipTrivial: false
    });
    check(
      off.steps.length === route.steps.length && off.skippedCount === 0,
      '显式关掉降噪时与默认结果一致（降噪是开关，不是隐式行为）'
    );
  }

  const capped = await request('route', { from: '', strategy: 'bfs', maxDepth: 6, maxSteps: 3 });
  check(
    capped.steps.length === 3 && capped.truncated === true,
    `maxSteps 截断生效：3 步，未展开 ${capped.frontierNodes} 个节点 / ${capped.frontierFiles} 个文件`
  );

  const dfsA = await request('route', { from: '', strategy: 'dfs', maxDepth: 4, maxSteps: 40 });
  const dfsB = await request('route', { from: '', strategy: 'dfs', maxDepth: 4, maxSteps: 40 });
  check(
    dfsA.steps.map((s) => s.name).join('>') === dfsB.steps.map((s) => s.name).join('>'),
    '同样参数下路线完全确定（可复现，测试才能打靶）'
  );

  // --- V2：候选（同名定义）与人工纠偏 ---
  // 无 compile_commands 时调用边按名字消解，「项目里还有别的同名定义」就等于可能走错边。
  // 这里只断言「引擎把候选如实报出来、并且允许改」，不断言「哪个候选才是对的」——
  // 那件事只有读代码的人知道。
  const withCand = route.steps.find((s) => (s.candidates ?? []).length > 0);
  check(
    !!withCand,
    withCand
      ? `同名定义候选：${withCand.name} 另有 ${withCand.candidateTotal} 处定义`
      : '同名定义候选：（demo 里应至少有一处）'
  );
  check(
    route.steps.every((s) => s.ambiguous === ((s.candidates ?? []).length > 0)),
    'ambiguous 与候选列表一致（不会出现「标了黄却无候选可选」）'
  );
  if (withCand) {
    const cands = withCand.candidates;
    check(cands.every((c) => c.id !== withCand.id), '候选里不含它自己');
    check(
      cands.every((c) => c.id && c.name === withCand.name && c.file && c.line > 0),
      '候选都带 id / 同名 / 文件位置'
    );
    check(
      withCand.candidateTotal >= cands.length && cands.length <= 20,
      `candidateTotal(${withCand.candidateTotal}) ≥ 列出的候选数(${cands.length})，且列出的不超过 20`
    );
  }

  // 纠偏：把某个调用点上按名字消解的结果换成同名候选里的另一个，路线必须真的改道。
  // 挑样本的条件只是「这一步不是起点且有候选」——
  // 断言写成「同名兄弟被去重」而不是「候选被搬到某个位置」：
  // 候选可能本来就在路线的别处（visited 只记一次），那样位置会漂，断言就不稳了。
  const overrideTarget = (() => {
    for (const step of route.steps) {
      if (step.parent === 0) continue;
      const parentStep = route.steps.find((x) => x.order === step.parent);
      if (parentStep && (step.candidates ?? []).length > 0) return { step, parentStep };
    }
    return undefined;
  })();
  if (overrideTarget) {
    const { step, parentStep } = overrideTarget;
    const chosen = step.candidates[0];
    // key 用「父节点 id|简单名」而不是步号：步号会随纠偏本身变化，节点 id 不会
    const key = `${parentStep.id}|${step.name}`;
    const corrected = await request('route', {
      from: '',
      strategy: 'bfs',
      maxDepth: 4,
      maxSteps: 80,
      overrides: { [key]: chosen.id }
    });
    const parentOrder = corrected.steps.find((s) => s.id === parentStep.id)?.order ?? -1;
    const siblings = corrected.steps.filter((s) => s.parent === parentOrder && s.name === step.name);
    check(
      siblings.length === 1 && siblings[0].id === chosen.id,
      `纠偏生效：${parentStep.name} 下的 ${step.name} 改走 ${chosen.file}:${chosen.line}` +
        `（原为 ${step.file}:${step.line}，同名兄弟由 2 个收敛为 1 个）`
    );
    check(
      !corrected.steps.some((s) => s.parent === parentOrder && s.id === step.id),
      `纠偏后 ${step.file}:${step.line} 不再是 ${parentStep.name} 的子节点（原边被换掉）`
    );
    const restored = await request('route', {
      from: '',
      strategy: 'bfs',
      maxDepth: 4,
      maxSteps: 80,
      overrides: {}
    });
    check(
      restored.steps.map((s) => s.id).join('>') === route.steps.map((s) => s.id).join('>'),
      '空 overrides 与不传 overrides 结果一致（纠偏可撤销）'
    );
  } else {
    check(false, '找不到可纠偏的样本（demo 应至少有一处同名定义）');
  }

  // --- V2：光标 → 符号（「从光标这里开始读」的入口）---
  // 大项目的 main 常常在平台相关文件里，真正想读的那条线未必从 main 起头。
  const mainStep = route.steps[0];
  const atMain = await request('nodeAt', { file: mainStep.file, line: mainStep.line + 1 });
  check(
    atMain.id === mainStep.id,
    `光标定位：${mainStep.file}:${mainStep.line + 1} → ${atMain.name}`
  );
  const runStep = route.steps.find((s) => s.id.endsWith('::Engine::run'));
  if (runStep) {
    const atRun = await request('nodeAt', { file: runStep.file, line: runStep.line + 2 });
    check(
      atRun.id === runStep.id,
      `光标定位：${runStep.file}:${runStep.line + 2} → ${atRun.name}（取所在函数，不是最近的任意符号）`
    );
  }
  // 从「光标定位到的节点」出发，第一条就是它自己 —— 这条链路要能闭合
  const cursorFrom = runStep ? runStep.id : atMain.id;
  const fromCursor = await request('route', {
    from: cursorFrom,
    strategy: 'bfs',
    maxDepth: 3,
    maxSteps: 40
  });
  check(
    fromCursor.from === cursorFrom && fromCursor.steps[0].id === cursorFrom,
    `从光标处出发：起点是 ${fromCursor.steps[0].name} 而不是 main`
  );

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

  // --- V3-c：没有 main 的库项目该从哪读起 ---
  // 起点候选 = 程序入口 → 公开接口（声明在 include/ 下）→ 调用图上的「根」。
  // 引擎**不替用户挑**：路线的全部价值就是顺序，起点错了后面整条都错。
  const libRoot = resolve(root, 'samples/libdemo');
  await request('scan', {
    root: libRoot,
    config: { ...config, cachePath: '', useCache: false, forceFull: true }
  });
  const libEntries = await request('entries', {});
  check(libEntries.hasMain === false, '库项目（没有 main）：entries 如实说「没有程序入口」');
  check(
    libEntries.candidates.length >= 3 && libEntries.candidates.every((c) => c.publicApi),
    `库项目的候选都是公开接口：${libEntries.candidates.map((c) => c.name).join('、')}`
  );
  check(
    libEntries.candidates.every((c) => c.apiHeader.startsWith('include/') && c.apiLine > 0),
    '每个公开接口都带「声明在哪个头文件」（否则用户没法核对）'
  );
  check(
    !libEntries.candidates.some((c) => c.name === 'isBlank' || c.name === 'addImpl'),
    '内部辅助（声明不在 include/ 下、匿名命名空间）不会被推荐成入口'
  );
  check(
    libEntries.candidates[0].callers === 0,
    `没人调用的排在前面：第一个候选 ${libEntries.candidates[0].name}（${libEntries.candidates[0].callers} 个调用者）`
  );
  const libEntriesAgain = await request('entries', {});
  check(
    libEntriesAgain.candidates.map((c) => c.id).join('>') ===
      libEntries.candidates.map((c) => c.id).join('>'),
    '同样输入下候选顺序完全确定（否则「推荐哪个」就没法讨论）'
  );
  // 库项目 route(from:'') 仍然要失败（引擎不猜），但错误信息得指路
  let libRouteError = '';
  try {
    await request('route', { from: '' });
  } catch (err) {
    libRouteError = err.message;
  }
  check(/entries/.test(libRouteError), `库项目 route 失败时指向 entries：${libRouteError}`);
  // 从候选起头，路线照样成立 —— 这才是库项目的正确用法
  const libRoute = await request('route', {
    from: libEntries.candidates[0].id,
    maxDepth: 4,
    maxSteps: 40
  });
  check(
    libRoute.steps.length > 1 && libRoute.steps[0].id === libEntries.candidates[0].id,
    `从公开接口起头：${libRoute.steps[0].name} → 共 ${libRoute.steps.length} 步`
  );
  // 图里也要能看出哪些节点是公开面（界面在表格 / 树 / 详情里标出来）
  const libGraph = await request('subgraph', {
    focus: 'func:libdemo::add',
    depth: 2,
    direction: 'both',
    maxNodes: 200
  });
  const libNode = (name) => libGraph.graph.nodes.find((n) => n.name === name);
  const apiNodes = libGraph.graph.nodes.filter((n) => n.apiHeader);
  check(
    apiNodes.length >= 1 && apiNodes.every((n) => n.apiHeader.startsWith('include/')),
    `图里标出公开接口节点：${apiNodes.map((n) => n.name).join('、')}`
  );
  check(
    libNode('add')?.apiHeader === 'include/libdemo/math.h' && libNode('add')?.apiLine > 0,
    `公开接口节点带着声明位置：add → ${libNode('add')?.apiHeader}:${libNode('add')?.apiLine}`
  );
  check(
    !!libNode('addImpl') && !libNode('addImpl').apiHeader,
    '内部实现（匿名命名空间）不会被标成公开接口'
  );

  // 回到 demo：有 main 时它永远是第一个候选（这一条在任何项目上都成立）
  await request('scan', { root: demoRoot, config: { ...config } });
  const demoEntries = await request('entries', {});
  check(
    demoEntries.hasMain === true &&
      demoEntries.candidates[0].mainLike &&
      demoEntries.candidates[0].name === 'main',
    `有 main 时它排第一：${demoEntries.candidates[0].name}`
  );
  check(
    demoEntries.candidates.some(
      (c) => c.name === 'config' && c.publicApi && c.apiHeader === 'include/demo/config.h'
    ),
    'demo 里 include/demo/config.h 的 config 也被认成公开接口'
  );

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
