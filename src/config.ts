import * as vscode from 'vscode';

import type { EngineConfig } from './engine/protocol';
import type { UiLanguage } from './i18n';

export interface DepScanConfig {
  language: UiLanguage;
  enginePath: string;
  onStartup: boolean;
  autoRebuildOnSave: boolean;
  parallelism: number;
  maxFiles: number;
  fileSizeLimitKB: number;
  includeGlobs: string[];
  excludeGlobs: string[];
  compileCommandsPath: string;
  includePaths: string[];
  defines: string[];
  systemIncludePaths: string[];
  deps: { includes: boolean; calls: boolean; types: boolean; symbols: boolean; links: boolean };
  graphDepth: number;
  graphDirection: 'both' | 'upstream' | 'downstream';
  graphMaxNodes: number;
  clusterByDirectory: boolean;
  cacheEnabled: boolean;
  cacheDirectory: string;
  logLevel: 'off' | 'error' | 'warn' | 'info' | 'debug';
}

export function readConfig(): DepScanConfig {
  const c = vscode.workspace.getConfiguration('depscan');
  return {
    language: c.get<UiLanguage>('ui.language', 'auto'),
    enginePath: c.get<string>('engine.path', ''),
    onStartup: c.get<boolean>('index.onStartup', true),
    autoRebuildOnSave: c.get<boolean>('index.autoRebuildOnSave', true),
    parallelism: c.get<number>('index.parallelism', 0),
    maxFiles: c.get<number>('index.maxFiles', 20000),
    fileSizeLimitKB: c.get<number>('index.fileSizeLimitKB', 2048),
    includeGlobs: c.get<string[]>('files.include', ['**/*.{c,cc,cpp,cxx,h,hh,hpp,hxx,inl,ipp}']),
    excludeGlobs: c.get<string[]>('files.exclude', [
      '**/node_modules/**',
      '**/.git/**',
      '**/build/**',
      '**/out/**',
      '**/cmake-build-*/**',
      '**/.cache/**'
    ]),
    compileCommandsPath: c.get<string>('compile.commandsPath', ''),
    includePaths: c.get<string[]>('compile.includePaths', []),
    defines: c.get<string[]>('compile.defines', []),
    systemIncludePaths: c.get<string[]>('compile.systemIncludePaths', []),
    deps: {
      includes: c.get<boolean>('deps.includes', true),
      calls: c.get<boolean>('deps.calls', true),
      types: c.get<boolean>('deps.types', true),
      symbols: c.get<boolean>('deps.symbols', true),
      links: c.get<boolean>('deps.links', true)
    },
    graphDepth: c.get<number>('graph.defaultDepth', 2),
    graphDirection: c.get<'both' | 'upstream' | 'downstream'>('graph.direction', 'both'),
    graphMaxNodes: c.get<number>('graph.maxNodes', 800),
    clusterByDirectory: c.get<boolean>('graph.clusterByDirectory', false),
    cacheEnabled: c.get<boolean>('cache.enabled', true),
    cacheDirectory: c.get<string>('cache.directory', ''),
    logLevel: c.get<'off' | 'error' | 'warn' | 'info' | 'debug'>('log.level', 'info')
  };
}

/** 转换为引擎配置（字段与 engine/src/rpc.cpp#applyConfig 对齐） */
export function toEngineConfig(cfg: DepScanConfig, opts: { cachePath?: string; forceFull?: boolean; includeExternal?: boolean } = {}): EngineConfig {
  return {
    includes: cfg.deps.includes,
    calls: cfg.deps.calls,
    types: cfg.deps.types,
    symbols: cfg.deps.symbols,
    links: cfg.deps.links,
    includeExternal: opts.includeExternal ?? false,
    includePaths: cfg.includePaths,
    systemIncludePaths: cfg.systemIncludePaths,
    defines: cfg.defines,
    includeGlobs: cfg.includeGlobs,
    excludeGlobs: cfg.excludeGlobs,
    fileSizeLimitBytes: cfg.fileSizeLimitKB * 1024,
    maxFiles: cfg.maxFiles,
    threads: cfg.parallelism,
    compileCommandsPath: cfg.compileCommandsPath,
    cachePath: opts.cachePath,
    useCache: cfg.cacheEnabled,
    forceFull: opts.forceFull ?? false
  };
}
