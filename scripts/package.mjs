// 打包 vsix：先收集对应平台的引擎到 engines/<platform>-<arch>/，再调用 vsce
//
// 用法：
//   node scripts/package.mjs                         # 本机平台
//   node scripts/package.mjs --target win32-x64      # 平台专用包
import { spawnSync } from 'child_process';
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync } from 'fs';
import { dirname, join, resolve } from 'path';
import { fileURLToPath } from 'url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/** 两个文件内容是否一致（小文件比内容，大文件退化为比 mtime） */
function sameFile(a, b) {
  try {
    const sa = statSync(a);
    const sb = statSync(b);
    if (sa.size !== sb.size) return false;
    if (sa.size > 4 * 1024 * 1024) return sa.mtimeMs === sb.mtimeMs;
    return readFileSync(a).equals(readFileSync(b));
  } catch {
    return false;
  }
}

const targetIndex = process.argv.indexOf('--target');
const target = targetIndex >= 0 ? process.argv[targetIndex + 1] : undefined;
const hostKey = `${process.platform}-${process.arch}`;

// .vscodeignore 的目录级否定（!media/**）会连带把 sourcemap 一起包含进来，
// 这里直接删掉开发用 sourcemap，保证 vsix 里只有运行时必需的产物。
for (const rel of ['media/webview.js.map', 'dist/extension.js.map']) {
  const p = resolve(root, rel);
  if (existsSync(p)) {
    rmSync(p, { force: true });
    console.log(`[package] 移除开发产物: ${rel}`);
  }
}

const engineKey = target ?? hostKey;
const exe = engineKey.startsWith('win32') ? 'depscan-core.exe' : 'depscan-core';

let copied = 0;
if (target && target !== hostKey) {
  // 不做交叉编译：目标平台不是本机时，只认已经预先放好的引擎二进制。
  const prepared = resolve(root, 'engines', target, exe);
  if (existsSync(prepared)) {
    console.log(`[package] 复用已有引擎: engines/${target}/${exe}`);
    copied = 1;
  } else {
    console.error(`[package] 目标平台 ${target} 与本机 ${hostKey} 不同，且 engines/${target}/${exe} 不存在。`);
    console.error('[package] 请在对应平台上执行 npm run build:core，再把二进制放进 engines/' + target + '/。');
    process.exit(1);
  }
} else {
  const candidates = [
    `engine/build/bin/Release/${exe}`,
    `engine/build/bin/RelWithDebInfo/${exe}`,
    `engine/build/bin/${exe}`
  ];
  for (const rel of candidates) {
    const src = resolve(root, rel);
    if (!existsSync(src)) continue;
    const destDir = resolve(root, 'engines', engineKey);
    const dest = join(destDir, exe);
    if (existsSync(dest) && sameFile(src, dest)) {
      console.log(`[package] 引擎未变化，沿用 engines/${engineKey}/${exe}`);
      copied = 1;
      break;
    }
    mkdirSync(destDir, { recursive: true });
    try {
      copyFileSync(src, dest);
    } catch (err) {
      if (err.code === 'EBUSY' || err.code === 'EPERM' || err.code === 'EACCES') {
        console.error(`[package] 无法覆盖 engines/${engineKey}/${exe} —— 文件正被占用。`);
        console.error('[package] 原因：正在运行的 VS Code 扩展宿主加载了这个引擎二进制（Windows 不允许覆盖运行中的 exe）。');
        console.error('[package] 处理：在「扩展」面板禁用 DepScan，或关闭该 VS Code 窗口，然后重跑本条命令。');
        console.error('          （打出来的包会带旧引擎，这正是必须「先 package 再 publish」的原因）');
        process.exit(1);
      }
      throw err;
    }
    console.log(`[package] 内置引擎: engines/${engineKey}/${exe}`);
    copied = 1;
    break;
  }
}

const enginesDir = resolve(root, 'engines');
if (existsSync(enginesDir)) {
  console.log('[package] 已内置平台:');
  for (const entry of readdirSync(enginesDir)) console.log(`  - ${entry}`);
}

if (copied === 0) {
  console.warn('[package] 未找到本机引擎产物，将打包不含引擎二进制的 vsix（用户需自行编译）');
}

const vsceFlags = ['package', '--no-dependencies', '--allow-missing-repository'];
if (target) vsceFlags.push('--target', target);

// Windows 上直接 spawn `npx.cmd` 会触发 Node 的 EINVAL（.cmd 需要 shell），因此走 cmd /c
const result =
  process.platform === 'win32'
    ? spawnSync(process.env.ComSpec ?? 'cmd.exe', ['/d', '/s', '/c', `npx --yes @vscode/vsce ${vsceFlags.join(' ')}`], {
        cwd: root,
        stdio: 'inherit'
      })
    : spawnSync('npx', ['--yes', '@vscode/vsce', ...vsceFlags], {
        cwd: root,
        stdio: 'inherit'
      });
if (result.error) {
  console.error(`[package] 调用 vsce 失败: ${result.error.message}`);
  console.error('[package] 若为离线环境，请在有网络的机器上执行 npx @vscode/vsce package');
  process.exit(1);
}
process.exit(result.status ?? 1);
