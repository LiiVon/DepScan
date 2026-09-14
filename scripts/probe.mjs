// 小型诊断脚本：扫描指定目录并输出节点/边摘要（用于定位解析问题）
import { spawnSync } from 'child_process';
import { existsSync } from 'fs';
import { dirname, resolve } from 'path';
import { fileURLToPath } from 'url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const project = resolve(process.argv[2] ?? 'engine/build/probe');
const showEdges = process.argv.includes('--edges');

const exe = process.platform === 'win32' ? '.exe' : '';
const engine = [
  `engine/build/bin/Release/depscan-core${exe}`,
  `engine/build/bin/depscan-core${exe}`
]
  .map((p) => resolve(root, p))
  .find((p) => existsSync(p));
if (!engine) {
  console.error('未找到引擎');
  process.exit(1);
}

const run = spawnSync(engine, ['--once', '--root', project], { encoding: 'buffer', maxBuffer: 512 * 1024 * 1024 });
if (run.status !== 0) {
  console.error(run.stderr?.toString('utf8'));
  process.exit(1);
}
const payload = JSON.parse(run.stdout.toString('utf8'));
console.log(`root=${payload.stats.root}`);
console.log(`files=${payload.stats.fileCount} symbols=${payload.stats.symbolCount} nodes=${payload.graph.nodes.length} edges=${payload.graph.edges.length}`);
console.log('edgeKinds:', JSON.stringify(payload.stats.edgeKindCounts));
console.log('nodeKinds:', JSON.stringify(payload.stats.nodeKindCounts));
console.log('unresolvedRefs:', payload.stats.unresolvedRefs);
console.log('--- nodes ---');
for (const n of payload.graph.nodes) {
  console.log(`  ${n.id}  [${n.kind}] ${n.file}:${n.line}${n.declaration ? ' (decl)' : ''}`);
}
if (showEdges) {
  console.log('--- edges ---');
  for (const e of payload.graph.edges) {
    console.log(`  ${e.from} --${e.kind}--> ${e.to}  @${e.file}:${e.line}`);
  }
}
