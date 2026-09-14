// 清理 CMake Tools 在 samples/demo 就地配置时留下的构建产物（保持示例目录干净）
import { existsSync, readdirSync, rmSync } from 'fs';
import { dirname, join, resolve } from 'path';
import { fileURLToPath } from 'url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const demo = resolve(root, 'samples/demo');
if (!existsSync(demo)) process.exit(0);

const DIRS = ['build', 'CMakeFiles', 'ALL_BUILD.dir', 'ZERO_CHECK.dir'];
const SUFFIXES = ['.vcxproj', '.vcxproj.filters', '.slnx', '.sln'];
const FILES = ['CMakeCache.txt', 'cmake_install.cmake', 'CMakeUserPresets.json'];

let removed = 0;
for (const entry of readdirSync(demo, { withFileTypes: true })) {
  const p = join(demo, entry.name);
  const isGeneratedDir =
    DIRS.includes(entry.name) || (entry.isDirectory() && entry.name.endsWith('.dir'));
  if (isGeneratedDir) {
    rmSync(p, { recursive: true, force: true });
    removed += 1;
    continue;
  }
  if (!entry.isFile()) continue;
  if (FILES.includes(entry.name) || SUFFIXES.some((s) => entry.name.endsWith(s))) {
    rmSync(p, { force: true });
    removed += 1;
  }
}
console.log(`[clean-sample] samples/demo 已清理 ${removed} 项 CMake 构建产物`);
