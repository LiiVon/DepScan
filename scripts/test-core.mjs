// 引擎自测：跑单测可执行文件 + 用真实样例做一次端到端扫描并校验 JSON
import { spawnSync } from 'child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { dirname, join, resolve } from 'path';
import { fileURLToPath } from 'url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const exe = process.platform === 'win32' ? '.exe' : '';

const CORE_CANDIDATES = [
  `engine/build/bin/Release/depscan-core${exe}`,
  `engine/build/bin/RelWithDebInfo/depscan-core${exe}`,
  `engine/build/bin/Debug/depscan-core${exe}`,
  `engine/build/bin/depscan-core${exe}`,
  `engines/${process.platform}-${process.arch}/depscan-core${exe}`
];

function findBinary(base) {
  for (const rel of CORE_CANDIDATES) {
    const p = resolve(root, rel.replace('depscan-core', base));
    if (existsSync(p)) return p;
  }
  return undefined;
}

const core = findBinary('depscan-core');
const testExe = findBinary('depscan-core-test');

if (!core || !testExe) {
  console.error('[test-core] 未找到引擎产物，请先运行 npm run build:core');
  process.exit(1);
}

let failed = false;

console.log(`[test-core] 单元测试: ${testExe}`);
const unit = spawnSync(testExe, [], { stdio: 'inherit' });
if (unit.status !== 0) failed = true;

console.log(`[test-core] 端到端扫描: samples/demo`);
const workDir = mkdtempSync(join(tmpdir(), 'depscan-e2e-'));
const outFile = join(workDir, 'graph.json');
const scan = spawnSync(core, ['--once', '--root', resolve(root, 'samples/demo')], {
  encoding: 'buffer',
  maxBuffer: 256 * 1024 * 1024
});
if (scan.status !== 0) {
  console.error(`[test-core] 扫描失败，退出码 ${scan.status}`);
  failed = true;
} else {
  writeFileSync(outFile, scan.stdout);
  const payload = JSON.parse(readFileSync(outFile, 'utf8'));
  const kinds = payload.stats.edgeKindCounts;
  const required = ['includes', 'calls', 'inherits', 'uses', 'links'];
  for (const kind of required) {
    const count = kinds[kind] ?? 0;
    const ok = count > 0;
    console.log(`  [${ok ? 'PASS' : 'FAIL'}] 识别到 ${kind} 依赖：${count} 条`);
    if (!ok) failed = true;
  }
  const nodeCount = payload.graph.nodes.length;
  const ok = nodeCount > 10 && payload.stats.fileCount >= 10;
  console.log(`  [${ok ? 'PASS' : 'FAIL'}] 生成图规模合理：${nodeCount} 节点 / ${payload.graph.edges.length} 边 / ${payload.stats.fileCount} 文件`);
  if (!ok) failed = true;
  const hasImportTarget = payload.graph.nodes.some((n) => n.kind === 'target');
  console.log(`  [${hasImportTarget ? 'PASS' : 'FAIL'}] 解析出构建目标（CMake add_library/add_executable）`);
  if (!hasImportTarget) failed = true;
}
rmSync(workDir, { recursive: true, force: true });

if (failed) {
  console.error('\n[test-core] 存在失败项');
  process.exit(1);
}
console.log('\n[test-core] 全部通过');
