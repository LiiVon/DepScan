import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';

export type EngineSource = 'config' | 'bundled' | 'dev';

export interface EngineLocation {
  path: string;
  source: EngineSource;
}

function isExecutableFile(p: string): boolean {
  try {
    return fs.statSync(p).isFile();
  } catch {
    return false;
  }
}

/** 平台目录名（与 .vscodeignore / scripts/build-core.mjs 中的约定一致） */
export function platformKey(): string {
  return `${process.platform}-${process.arch}`;
}

export function engineBinaryName(): string {
  return process.platform === 'win32' ? 'depscan-core.exe' : 'depscan-core';
}

/**
 * 依次尝试：
 *   1. 用户配置 depscan.engine.path
 *   2. vsix 内置 engines/<platform>-<arch>/depscan-core[.exe]
 *   3. 开发态 engine/build/bin/<Config>/depscan-core[.exe]
 */
export function resolveEnginePath(
  extensionUri: vscode.Uri,
  configured: string
): EngineLocation | undefined {
  const exe = engineBinaryName();
  const root = extensionUri.fsPath;
  const candidates: EngineLocation[] = [];

  if (configured.trim()) {
    candidates.push({ path: configured.trim(), source: 'config' });
  }
  candidates.push({ path: path.join(root, 'engines', platformKey(), exe), source: 'bundled' });
  for (const cfg of ['Release', 'RelWithDebInfo', 'MinSizeRel', 'Debug']) {
    candidates.push({ path: path.join(root, 'engine', 'build', 'bin', cfg, exe), source: 'dev' });
  }
  candidates.push({ path: path.join(root, 'engine', 'build', 'bin', exe), source: 'dev' });

  for (const c of candidates) {
    if (isExecutableFile(c.path)) return c;
  }
  return undefined;
}
