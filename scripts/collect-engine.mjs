// 把构建出来的引擎二进制归位到 engines/<platform>-<arch>/<exe>。
//
// 为什么需要单独一个脚本：不同 CMake 生成器的输出路径不一样 ——
//   Visual Studio / Xcode（多配置）：engine/build/bin/<Config>/depscan-core[.exe]
//   Makefiles / Ninja（单配置）   ：engine/build/bin/depscan-core[.exe]
// CI 里还要按指定平台（而不是当前机器）归位，所以不写死路径，改成递归查找。
//
// 本地用法：npm run build:core && node scripts/collect-engine.mjs
// CI 用法  ：node scripts/collect-engine.mjs --key win32-x64
import { chmodSync, copyFileSync, existsSync, mkdirSync, readdirSync } from 'fs';
import { dirname, join, resolve } from 'path';
import { fileURLToPath } from 'url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const keyIndex = process.argv.indexOf('--key');
const key = (keyIndex >= 0 ? process.argv[keyIndex + 1] : undefined) ?? `${process.platform}-${process.arch}`;
const exe = key.startsWith('win32') ? 'depscan-core.exe' : 'depscan-core';

/** 在 bin 目录下递归找引擎可执行文件（先看当前层，再往下钻） */
function findBinary(dir, depth = 0) {
  if (depth > 3) return undefined;
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return undefined;
  }
  for (const e of entries) {
    if (e.isFile() && e.name === exe) return join(dir, e.name);
  }
  for (const e of entries) {
    if (!e.isDirectory()) continue;
    const hit = findBinary(join(dir, e.name), depth + 1);
    if (hit) return hit;
  }
  return undefined;
}

const binDir = resolve(root, 'engine/build/bin');
const src = findBinary(binDir);
if (!src) {
  console.error(`[collect-engine] 在 ${binDir} 下找不到 ${exe}`);
  console.error('[collect-engine] 先执行 npm run build:core');
  process.exit(1);
}

const destDir = resolve(root, 'engines', key);
mkdirSync(destDir, { recursive: true });
const dest = join(destDir, exe);

try {
  copyFileSync(src, dest);
} catch (err) {
  if (err.code === 'EBUSY' || err.code === 'EPERM' || err.code === 'EACCES') {
    console.error(`[collect-engine] 无法覆盖 engines/${key}/${exe} —— 文件正被占用。`);
    console.error('[collect-engine] 原因：正在运行的 VS Code 扩展宿主加载了这个引擎（Windows 不允许覆盖运行中的 exe）。');
    console.error('[collect-engine] 处理：禁用 DepScan 扩展或关掉那个 VS Code 窗口后重试。');
    process.exit(1);
  }
  throw err;
}

// 非 Windows 平台必须保留可执行位；CI 上传/下载 artifact 会丢掉它，所以显式补一次。
if (!key.startsWith('win32')) {
  try {
    chmodSync(dest, 0o755);
  } catch {
    /* 忽略：某些文件系统不支持 */
  }
}

console.log(`[collect-engine] ${src}  ->  engines/${key}/${exe}`);
