// 打包 vsix：先收集三平台引擎到 engines/<platform>-<arch>/，再调用 vsce
import { spawnSync } from 'child_process';
import { copyFileSync, existsSync, mkdirSync, readdirSync, rmSync } from 'fs';
import { dirname, join, resolve } from 'path';
import { fileURLToPath } from 'url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');

// .vscodeignore 的目录级否定（!media/**）会连带把 sourcemap 一起包含进来，
// 这里直接删掉开发用 sourcemap，保证 vsix 里只有运行时必需的产物。
for (const rel of ['media/webview.js.map', 'dist/extension.js.map']) {
  const p = resolve(root, rel);
  if (existsSync(p)) {
    rmSync(p, { force: true });
    console.log(`[package] 移除开发产物: ${rel}`);
  }
}
const key = `${process.platform}-${process.arch}`;
const exe = process.platform === 'win32' ? 'depscan-core.exe' : 'depscan-core';

const candidates = [
  `engine/build/bin/Release/${exe}`,
  `engine/build/bin/RelWithDebInfo/${exe}`,
  `engine/build/bin/${exe}`
];

let copied = 0;
for (const rel of candidates) {
  const src = resolve(root, rel);
  if (!existsSync(src)) continue;
  const destDir = resolve(root, 'engines', key);
  mkdirSync(destDir, { recursive: true });
  copyFileSync(src, join(destDir, exe));
  console.log(`[package] 内置引擎: engines/${key}/${exe}`);
  copied += 1;
  break;
}

const enginesDir = resolve(root, 'engines');
if (existsSync(enginesDir)) {
  console.log('[package] 已内置平台:');
  for (const entry of readdirSync(enginesDir)) console.log(`  - ${entry}`);
}

if (copied === 0) {
  console.warn('[package] 未找到本机引擎产物，将打包不含引擎二进制的 vsix（用户需自行编译）');
}

// Windows 上直接 spawn `npx.cmd` 会触发 Node 的 EINVAL（.cmd 需要 shell），因此走 cmd /c
const vsceArgs = 'npx --yes @vscode/vsce package --no-dependencies --allow-missing-repository';
const result =
  process.platform === 'win32'
    ? spawnSync(process.env.ComSpec ?? 'cmd.exe', ['/d', '/s', '/c', vsceArgs], {
        cwd: root,
        stdio: 'inherit'
      })
    : spawnSync('npx', ['--yes', '@vscode/vsce', 'package', '--no-dependencies', '--allow-missing-repository'], {
        cwd: root,
        stdio: 'inherit'
      });
if (result.error) {
  console.error(`[package] 调用 vsce 失败: ${result.error.message}`);
  console.error('[package] 若为离线环境，请在有网络的机器上执行 npx @vscode/vsce package');
  process.exit(1);
}
process.exit(result.status ?? 1);
