// 跨平台构建 C++ 引擎：cmake 配置 + 编译（Release）
import { spawnSync } from 'child_process';
import { existsSync } from 'fs';
import { dirname, resolve } from 'path';
import { fileURLToPath } from 'url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const buildDir = resolve(root, 'engine/build');

const CMAKE_CANDIDATES = [
  'cmake',
  'C:\\Program Files\\CMake\\bin\\cmake.exe',
  'C:\\Program Files (x86)\\CMake\\bin\\cmake.exe',
  '/usr/bin/cmake',
  '/usr/local/bin/cmake',
  '/opt/homebrew/bin/cmake'
];

function findCmake() {
  for (const candidate of CMAKE_CANDIDATES) {
    if (candidate.includes('\\') || candidate.includes('/')) {
      if (existsSync(candidate)) return candidate;
      continue;
    }
    const probe = spawnSync(candidate, ['--version'], { encoding: 'utf8', shell: false });
    if (!probe.error && probe.status === 0) return candidate;
  }
  return undefined;
}

const cmake = findCmake();
if (!cmake) {
  console.error('[build-core] 未找到 cmake，请先安装 CMake 并加入 PATH');
  process.exit(1);
}

const configureArgs = ['-S', resolve(root, 'engine'), '-B', buildDir, '-DDEPS_BUILD_TESTS=ON'];
if (process.platform !== 'win32') configureArgs.push('-DCMAKE_BUILD_TYPE=Release');

console.log(`[build-core] ${cmake} ${configureArgs.join(' ')}`);
const configure = spawnSync(cmake, configureArgs, { stdio: 'inherit' });
if (configure.status !== 0) process.exit(configure.status ?? 1);

const buildArgs = ['--build', buildDir, '--parallel'];
if (process.platform === 'win32') buildArgs.push('--config', 'Release');
console.log(`[build-core] ${cmake} ${buildArgs.join(' ')}`);
const buildResult = spawnSync(cmake, buildArgs, { stdio: 'inherit' });
if (buildResult.status !== 0) process.exit(buildResult.status ?? 1);

console.log('[build-core] 完成');
