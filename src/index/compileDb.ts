import * as fs from 'fs';
import * as path from 'path';

/**
 * `compile_commands.json` 的查找结果。
 *
 * 这份 TS 实现刻意与 C++ 引擎的 `findCompileCommands` 保持**同样的查找顺序**，
 * 目的不是替代引擎，而是让扩展侧（面板刷新、精度诊断命令）能低成本地回答
 * 「现在到底有没有编译数据库 / 它比上次扫描更新了吗」。
 */
export interface CompileDbInfo {
  /** 找到的 compile_commands.json 绝对路径；未找到为 undefined */
  path?: string;
  /** 修改时间（毫秒）；未找到为 0 */
  mtimeMs: number;
  /** 实际检查过的目录（按顺序），用于诊断输出 */
  searched: string[];
  /**
   * “看起来是构建目录（有 CMakeCache.txt）但没有 compile_commands.json”的目录。
   *
   * 这是「我明明编译了，为什么还是近似」的头号原因：CMake 的
   * `CMAKE_EXPORT_COMPILE_COMMANDS` **只对 Makefile / Ninja 生成器有效**，
   * Visual Studio 生成器（CMake Tools 的默认 Kit）即使打开这个开关也不产出。
   */
  staleBuilds: string[];
}

/**
 * 优先检查的相对目录，顺序与引擎 `findCompileCommands` 的 kCandidates 一致。
 * `out/build/<预设名>/` 这类 CMake 预设布局由下面的递归兜底覆盖。
 */
const CANDIDATES = [
  '',
  'build',
  'out',
  'cmake-build-debug',
  'cmake-build-release',
  'build/Release',
  'build/Debug'
];

const MAX_DEPTH = 4;
const SKIP_DIRS = new Set(['node_modules', '_deps', 'CMakeFiles', 'depscaner-cache']);

/** 文件 mtime（毫秒）；不存在或不是文件返回 0 */
export function fileMtimeMs(p: string): number {
  try {
    const st = fs.statSync(p);
    return st.isFile() ? st.mtimeMs : 0;
  } catch {
    return 0;
  }
}

export function findCompileCommands(root: string): CompileDbInfo {
  const searched: string[] = [];
  for (const rel of CANDIDATES) {
    const dir = rel ? path.join(root, rel) : root;
    if (!fs.existsSync(dir)) continue;
    searched.push(dir);
    const candidate = path.join(dir, 'compile_commands.json');
    const mtime = fileMtimeMs(candidate);
    if (mtime > 0) return { path: candidate, mtimeMs: mtime, searched, staleBuilds: [] };
  }

  // 兜底：有限深度递归（很多 CMake 预设把生成物放在 out/build/<预设名>/ 下）
  const walked: string[] = [];
  const found = walk(root, 0, walked);
  const all = searched.concat(walked);
  return {
    path: found,
    mtimeMs: found ? fileMtimeMs(found) : 0,
    searched: all,
    staleBuilds: found ? [] : all.filter((d) => fileMtimeMs(path.join(d, 'CMakeCache.txt')) > 0)
  };
}

function walk(dir: string, depth: number, visited: string[]): string | undefined {
  if (depth > MAX_DEPTH) return undefined;
  visited.push(dir);
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return undefined;
  }
  for (const e of entries) {
    if (e.isFile() && e.name === 'compile_commands.json') return path.join(dir, e.name);
  }
  for (const e of entries) {
    if (!e.isDirectory()) continue;
    if (e.name.startsWith('.') || SKIP_DIRS.has(e.name)) continue;
    const hit = walk(path.join(dir, e.name), depth + 1, visited);
    if (hit) return hit;
  }
  return undefined;
}