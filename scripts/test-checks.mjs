// 架构边界检查的**文案与级别**离线断言。
//
// 引擎报什么由 C++ 自测钉住（合成的图最能说清「报 / 不报」，见 engine/test/test_main.cpp 的 [检查] 组），
// 这里只管后半段：违规 → 「问题」面板里那一行（message / code / severity / 汇总）。
// 这一段以前只能靠肉眼打开面板看，而「说清了后果没有」「截断时有没有如实说」恰恰最容易出错。
import { build } from 'esbuild';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { dirname, join, resolve } from 'path';
import { fileURLToPath, pathToFileURL } from 'url';

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

const workDir = mkdtempSync(join(tmpdir(), 'depscaner-checks-'));
const outfile = join(workDir, 'violationModel.mjs');
await build({
  entryPoints: [resolve(root, 'src/views/violationModel.ts')],
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node18',
  outfile,
  logLevel: 'error'
});
const model = await import(pathToFileURL(outfile).href);

// 形状照引擎真实的输出（demo 的 core ⇄ ui，和 libdemo 里人为构造的泄漏）
const cycle = {
  kind: 'directory-cycle',
  fromFile: 'src/core/registry.h',
  fromLine: 9,
  toFile: '',
  dirs: ['src/core', 'src/ui'],
  edgeCount: 3
};
const leak = {
  kind: 'public-api-leak',
  fromFile: 'include/libdemo/log.h',
  fromLine: 3,
  toFile: 'src/internal.h',
  edgeCount: 0
};

// --- 1. 目录环 ---
const cycleDiag = model.violationDiagnostic(cycle);
check(cycleDiag.code === 'depscaner.directory-cycle', `code 带前缀，便于筛选与写进 CI：${cycleDiag.code}`);
check(
  cycleDiag.severity === 'warning',
  '级别统一 warning —— 架构气味不该报成错误（那是「编译不过」的位置）'
);
check(
  cycleDiag.file === 'src/core/registry.h' && cycleDiag.line === 9,
  '诊断落在能跳转的那一行'
);
check(
  cycleDiag.message.includes('src/core ↔ src/ui') && cycleDiag.message.includes('3 条边'),
  `环说清是哪几个目录互引、多少条边：${cycleDiag.message}`
);
check(/分层/.test(cycleDiag.message), '说清后果（分层无从谈起），而不是只说「有个环」');

// --- 2. 公开面泄漏 ---
const leakDiag = model.violationDiagnostic(leak);
check(
  leakDiag.code === 'depscaner.public-api-leak' && leakDiag.line === 3 && leakDiag.severity === 'warning',
  '泄漏有自己的 code，级别与环一致'
);
check(
  leakDiag.message.includes('src/internal.h') && /编译不过/.test(leakDiag.message),
  `泄漏说清「谁引了谁」与后果：${leakDiag.message}`
);

// --- 3. 汇总：干净 / 分类计数 / 截断时如实说 ---
const none = model.violationsSummary({ violations: [], total: 0 });
check(/没问题/.test(none), `干净时给一句明确的话：${none}`);
const both = model.violationsSummary({ violations: [leak, cycle], total: 2 });
check(
  both.includes('2 处') && both.includes('公开面泄漏 1') && both.includes('目录循环 1'),
  `汇总把两类分开数：${both}`
);
const truncated = model.violationsSummary({ violations: [leak], total: 7 });
check(
  truncated.includes('7 处') && truncated.includes('前 1 处'),
  `截断时如实说 —— 别把「只列了 1 个」说成「一共 1 个」：${truncated}`
);

// --- 4. 批量转换 ---
const diags = model.violationDiagnostics({ violations: [leak, cycle], total: 2 });
check(
  diags.length === 2 && diags[0].code !== diags[1].code,
  '逐条转换，两类违规的 code 不同（面板里能分开筛）'
);

rmSync(workDir, { recursive: true, force: true });

if (failures.length) {
  console.error(`\n[test-checks] 失败 ${failures.length} 项`);
  for (const f of failures) console.error(`  - ${f}`);
  process.exit(1);
}
console.log('\n[test-checks] 全部通过');
