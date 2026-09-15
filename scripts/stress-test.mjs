// 端到端压力测试：调用引擎 --once 扫描指定工程，测量真实耗时并生成报告。
// 用法: node scripts/stress-test.mjs <项目目录> [报告输出路径]
import { spawnSync } from 'child_process';
import { existsSync, readFileSync, readdirSync, writeFileSync } from 'fs';
import { dirname, join, resolve } from 'path';
import { fileURLToPath } from 'url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const project = resolve(process.argv[2] ?? 'stress');
const reportPath = resolve(process.argv[3] ?? 'engine/build/stress-report.md');

const exe = process.platform === 'win32' ? '.exe' : '';
const engine = [
  `engine/build/bin/Release/depscaner-core${exe}`,
  `engine/build/bin/depscaner-core${exe}`
]
  .map((p) => resolve(root, p))
  .find((p) => existsSync(p));

if (!engine) {
  console.error('[stress] 未找到引擎，请先 npm run build:core');
  process.exit(1);
}
if (!existsSync(project)) {
  console.error(`[stress] 项目目录不存在: ${project}（可先执行 node scripts/gen-stress.mjs）`);
  process.exit(1);
}

function countSourceLines(dir) {
  const walk = (d) => {
    let files = 0;
    let lines = 0;
    for (const entry of readdirSync(d, { withFileTypes: true })) {
      const p = join(d, entry.name);
      if (entry.isDirectory()) {
        if (entry.name === '.git' || entry.name === 'build') continue;
        const sub = walk(p);
        files += sub.files;
        lines += sub.lines;
      } else if (/\.(c|cc|cpp|cxx|h|hh|hpp|hxx|inl|ipp)$/i.test(entry.name)) {
        files += 1;
        lines += readFileSync(p, 'utf8').split('\n').length;
      }
    }
    return { files, lines };
  };
  return walk(dir);
}

const loc = countSourceLines(project);
console.log(`[stress] 目标工程: ${project}`);
console.log(`[stress] 规模: ${loc.files} 个源文件 / ${loc.lines} 行`);

const started = Date.now();
const run = spawnSync(engine, ['--once', '--root', project], {
  encoding: 'buffer',
  maxBuffer: 1024 * 1024 * 1024
});
const wallMs = Date.now() - started;

if (run.status !== 0) {
  console.error(`[stress] 扫描失败，退出码 ${run.status}`);
  console.error(run.stderr?.toString('utf8')?.slice(0, 2000));
  process.exit(1);
}

const payload = JSON.parse(run.stdout.toString('utf8'));
const s = payload.stats;
const jsonMb = run.stdout.length / 1048576;

const lines = [];
lines.push(`# DepScaner 压力测试报告`);
lines.push('');
lines.push(`- 生成时间: ${new Date().toISOString().replace('T', ' ').slice(0, 19)}`);
lines.push(`- 测试工程: \`${project}\`（合成生成，非真实项目）`);
lines.push(`- 规模: **${loc.files} 个源文件 / ${loc.lines} 行代码**`);
lines.push(`- 平台: ${process.platform}-${process.arch}，Node ${process.version}`);
lines.push('');
lines.push('## 结果');
lines.push('');
lines.push('| 指标 | 数值 |');
lines.push('| --- | --- |');
lines.push(`| 进程墙钟时间（含启动+文件发现+解析+建图+序列化） | ${wallMs} ms |`);
lines.push(`| 引擎内部索引耗时 | ${Math.round(s.elapsedMs)} ms |`);
lines.push(`| 文件数 | ${s.fileCount} |`);
lines.push(`| 符号数 | ${s.symbolCount} |`);
lines.push(`| 节点 / 边 | ${payload.graph.nodes.length} / ${payload.graph.edges.length} |`);
lines.push(`| 跳过文件（超大） | ${s.skippedFiles} |`);
lines.push(`| 未解析引用 | ${s.unresolvedRefs} |`);
lines.push(`| 输出 JSON 体积 | ${jsonMb.toFixed(1)} MB |`);
lines.push(`| 吞吐（墙钟） | ${Math.round(loc.lines / (wallMs / 1000) / 1000)} K 行/秒 |`);
lines.push('');
lines.push('> 说明：v0.1 未对峰值内存插桩，因此这里不报告内存数字（避免给出没有依据的估算）。');
lines.push('> 自行测量：Windows 用任务管理器观察 `depscaner-core.exe` 工作集；Linux 用 `/usr/bin/time -v <engine> --once --root <dir>` 看 Maximum resident set size。');
lines.push('> 另外：合成代码高度重复（无模板元编程、无深层嵌套），因此吞吐好于真实项目，数字应视为**上限参考**。');
lines.push('');
lines.push('## 依赖分布');
lines.push('');
lines.push('| 类型 | 数量 |');
lines.push('| --- | --- |');
for (const [kind, count] of Object.entries(s.edgeKindCounts)) {
  lines.push(`| ${kind} | ${count} |`);
}
lines.push('');
lines.push('## 复现方式');
lines.push('');
lines.push('```bash');
lines.push('node scripts/gen-stress.mjs stress 3000 100     # 生成合成工程');
lines.push('node scripts/stress-test.mjs stress             # 扫描并生成本报告');
lines.push('```');

writeFileSync(reportPath, lines.join('\n'), 'utf8');
console.log(`\n[stress] 报告已写入 ${reportPath}`);
console.log(lines.filter((l) => l.startsWith('|') && !l.includes('---')).join('\n'));
