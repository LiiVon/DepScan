// 非 ASCII 路径回归测试（起因：用户在公司大项目上实测失败）。
//
// 日志原文：
//   索引失败: 扫描过程中抛出异常: No mapping for the Unicode character exists in the
//   target multi-byte code page.
//
// 根因：引擎里所有「UTF-8 的 std::string ↔ std::filesystem::path」都走 MSVC 的
// **ANSI 代码页（本机 936/GBK）** 转换，而不是 UTF-8：
//   · fs::path(utf8String)            → MultiByteToWideChar(CP_ACP)：字节不是合法 GBK 就抛异常
//   · entry.path().generic_string()   → WideCharToMultiByte(CP_ACP)：名字不在 GBK 里就抛异常
//   · std::ifstream(utf8String)       → 也按 ANSI 打开（中文名文件静默读不到）
// ASCII 名的项目永远踩不到，所以 demo / 自造样例一路绿灯，一上真实项目就炸。
//
// 本测试钉住的行为：**目录名、文件名含非 GBK 字符时也要能扫，且路径必须是原样的 UTF-8**
// （emoji 是故意选的：它一定不在 GBK 里，正是本机必抛异常的那种名字）。
import { spawnSync } from 'child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
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
  console.error('[test-unicode] 未找到引擎，请先 npm run build:core');
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

// ── 样例工程：根目录带空格，两个子目录分别是「中文」和「emoji」 ──
const work = mkdtempSync(join(tmpdir(), 'depscaner-unicode-'));
const project = join(work, 'my project');  // 根目录带空格（真实项目很常见）
const chineseDir = join(project, '中文目录');
const emojiDir = join(project, 'emoji-😀');  // emoji 不在 GBK 里 → 旧实现必抛异常
mkdirSync(chineseDir, { recursive: true });
mkdirSync(emojiDir, { recursive: true });

const files = {
  [join(project, 'main.cpp')]: '#include "中文目录/头文件.h"\n#include "emoji-😀/beta.h"\n\nint main() {\n  return alphaValue() + betaValue();\n}\n',
  [join(chineseDir, '头文件.h')]: '// 中文注释：目录名与文件名都是非 ASCII\nint alphaValue();\n',
  [join(chineseDir, 'alpha.cpp')]: '#include "头文件.h"\n\nint alphaValue() { return 42; }\n',
  [join(emojiDir, 'beta.h')]: 'int betaValue();\n',
  [join(emojiDir, 'beta.cpp')]: '#include "beta.h"\n\nint betaValue() { return 7; }\n'
};
for (const [path, content] of Object.entries(files)) writeFileSync(path, content, 'utf8');

const result = spawnSync(enginePath, ['--once', '--root', project, '--jobs', '1'], {
  encoding: 'utf8',
  windowsHide: true,
  maxBuffer: 64 * 1024 * 1024
});
const stderr = result.stderr ?? '';
const stdout = result.stdout ?? '';

if (result.status !== 0) console.error(`[test-unicode] 引擎退出码 ${result.status}\n${stderr}`);

// 1) 核心回归：不许因为路径里的字符抛异常
check(result.status === 0, `引擎正常退出（退出码 0，实际 ${result.status}）`);
check(!/No mapping for the Unicode character/i.test(stderr), 'stderr 里没有 "No mapping for the Unicode character"');

// 1.5) 清单也要真的链接进 exe（改 CMake 时很容易悄悄丢掉这行，而丢了之后
//      在 ASCII 项目上完全看不出来）
check(
  readFileSync(enginePath).includes(Buffer.from('activeCodePage')),
  'exe 内嵌了 UTF-8 活动代码页清单（/MANIFESTINPUT）'
);

// 2) 输出必须是合法 JSON（旧实现里这一步连输出都没有）
let payload = null;
try {
  payload = JSON.parse(stdout);
  check(true, '--once 输出一份合法 JSON');
} catch (err) {
  check(false, `--once 输出必须是合法 JSON（${err.message}）`);
}

if (payload) {
  const nodes = payload.graph?.nodes ?? [];
  const edges = payload.graph?.edges ?? [];
  const stats = payload.stats ?? {};
  const nodeFiles = new Set(nodes.map((n) => n.file));

  // 3) 路径原样保留（UTF-8，正斜杠），不能被吃掉、不能被转成问号/乱码
  const expected = [
    'main.cpp',
    '中文目录/头文件.h',
    '中文目录/alpha.cpp',
    'emoji-😀/beta.h',
    'emoji-😀/beta.cpp'
  ];
  for (const rel of expected) {
    check(nodeFiles.has(rel), `图里有 ${rel}（路径原样 UTF-8）`);
  }
  check(
    ![...nodeFiles].some((f) => f.includes('?') || f.includes('\uFFFD')),
    '没有任何路径被转成问号或替换字符'
  );

  // 4) 非 ASCII 目录里的 include 也要解析成功（旧实现里 ifstream 打不开中文名文件）
  const hasEdge = (from, to) =>
    edges.some((e) => e.from.endsWith(`:${from}`) && e.to.endsWith(`:${to}`));
  check(hasEdge('main', 'alphaValue'), 'main → alphaValue 调用边解析成功（中文目录里的定义）');
  check(hasEdge('main', 'betaValue'), 'main → betaValue 调用边解析成功（emoji 目录里的定义）');

  // 5) 统计上也不能少文件（旧实现会把这些文件当"读不到"跳过）
  check((stats.fileCount ?? 0) >= expected.length, `fileCount ≥ ${expected.length}（实际 ${stats.fileCount}）`);
  check(
    !(stats.warnings ?? []).some((w) => /中文目录|emoji/.test(w)),
    '没有把非 ASCII 路径的文件记成警告'
  );
}

rmSync(work, { recursive: true, force: true });

if (failures.length > 0) {
  console.error(`\n非 ASCII 路径测试失败：${failures.length} 项`);
  process.exit(1);
}
console.log('\n非 ASCII 路径测试通过');
