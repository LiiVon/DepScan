// 读取引擎 --once 的 JSON 输出并打印摘要（压力测试报告用）
import { readFileSync, statSync } from 'fs';

const file = process.argv[2];
if (!file) {
  console.error('用法: node scripts/stress-report.mjs <graph.json>');
  process.exit(1);
}
const bytes = statSync(file).size;
const payload = JSON.parse(readFileSync(file, 'utf8'));
const s = payload.stats;
console.log(`JSON 体积      : ${(bytes / 1048576).toFixed(1)} MB`);
console.log(`文件数         : ${s.fileCount}`);
console.log(`符号数         : ${s.symbolCount}`);
console.log(`节点 / 边      : ${payload.graph.nodes.length} / ${payload.graph.edges.length}`);
console.log(`引擎内部耗时   : ${Math.round(s.elapsedMs)} ms`);
console.log(`精度           : ${s.precision}（compile_commands: ${s.compileCommandsFound}）`);
console.log('依赖分布       :');
for (const [kind, count] of Object.entries(s.edgeKindCounts)) {
  console.log(`  ${kind.padEnd(9)}: ${count}`);
}
