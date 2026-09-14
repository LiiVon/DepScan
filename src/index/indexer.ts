import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';

import { readConfig, toEngineConfig, type DepScanConfig } from '../config';
import { findCompileCommands, fileMtimeMs } from './compileDb';
import { EngineClient } from '../engine/client';
import { resolveEnginePath, type EngineLocation } from '../engine/locator';
import type { Direction, ExportResult, PingResult, SubgraphResult } from '../engine/protocol';
import type { GraphData, ScanStats } from '../graph/model';
import { s } from '../i18n';
import { precisionLabel } from '../i18n';
import type { Logger } from '../util/log';

export type IndexState = 'idle' | 'indexing' | 'ready' | 'error';

export interface IndexStatus {
  state: IndexState;
  message: string;
  done: number;
  total: number;
  stats?: ScanStats;
}

const SUPPORTED = /\.(c|cc|cpp|cxx|c\+\+|h|hh|hpp|hxx|h\+\+|inl|ipp|tcc|inc)$/i;

/**
 * 索引服务：负责
 *   - 引擎进程生命周期（spawn / 重启 / 关闭）
 *   - 全量扫描 + 增量更新（保存事件 / 文件增删）
 *   - 磁盘缓存目录管理
 *   - 子图 / 架构 / 导出查询
 */
export class IndexService implements vscode.Disposable {
  private client: EngineClient | undefined;
  private location: EngineLocation | undefined;
  private watcher: vscode.FileSystemWatcher | undefined;
  private compileDbWatcher: vscode.FileSystemWatcher | undefined;
  private compileDbTimer: NodeJS.Timeout | undefined;
  /** 上次扫描时实际生效的编译数据库（路径 + mtime），用于判断是否需要重扫 */
  private compileDbUsed: { path: string; mtimeMs: number } | undefined;
  private readonly disposables: vscode.Disposable[] = [];
  private readonly debounceTimers = new Map<string, NodeJS.Timeout>();
  private scanning = false;

  private status: IndexStatus = { state: 'idle', message: '', done: 0, total: 0 };

  readonly onDidChangeStatus = new vscode.EventEmitter<IndexStatus>();
  readonly onDidUpdateGraph = new vscode.EventEmitter<{ files: string[]; stats: ScanStats }>();

  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly logger: Logger
  ) {}

  get root(): string | undefined {
    return vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  }

  get currentStatus(): IndexStatus {
    return this.status;
  }

  get isScanning(): boolean {
    return this.scanning;
  }

  get engineLocation(): EngineLocation | undefined {
    return this.location;
  }

  // ------------------------------ 生命周期 ------------------------------

  async initialize(): Promise<void> {
    this.disposables.push(
      vscode.workspace.onDidSaveTextDocument((doc) => {
        const cfg = readConfig();
        if (!cfg.autoRebuildOnSave) return;
        if (doc.uri.scheme !== 'file' || !SUPPORTED.test(doc.uri.fsPath)) return;
        this.scheduleUpdate(doc.uri.fsPath);
      }),
      vscode.workspace.onDidChangeConfiguration((e) => {
        if (e.affectsConfiguration('depscan')) {
          this.logger.setLevel(readConfig().logLevel);
        }
      })
    );

    this.watcher = vscode.workspace.createFileSystemWatcher('**/*.{c,cc,cpp,cxx,h,hh,hpp,hxx,inl,ipp}');
    this.disposables.push(
      this.watcher,
      this.watcher.onDidCreate((uri) => this.scheduleUpdate(uri.fsPath)),
      this.watcher.onDidDelete((uri) => this.scheduleUpdate(uri.fsPath))
    );

    // 编译数据库出现/更新/删除 → 包含路径、宏、以及链接器输入全都变了，
    // 精度也会变。此时缓存指纹会失配，必须整体重解析，不能走增量。
    this.compileDbWatcher = vscode.workspace.createFileSystemWatcher('**/compile_commands.json');
    const onCompileDb = (uri: vscode.Uri) => this.scheduleCompileDbRescan(uri.fsPath);
    this.disposables.push(
      this.compileDbWatcher,
      this.compileDbWatcher.onDidCreate(onCompileDb),
      this.compileDbWatcher.onDidChange(onCompileDb),
      this.compileDbWatcher.onDidDelete(onCompileDb)
    );
  }

  async ensureStarted(): Promise<boolean> {
    if (this.client?.running) return true;
    const cfg = readConfig();
    const loc = resolveEnginePath(this.context.extensionUri, cfg.enginePath);
    if (!loc) {
      this.logger.error(s().engine.missing);
      void vscode.window.showErrorMessage(`${s().engine.missing} ${s().engine.missingHint}`);
      this.setStatus({ state: 'error', message: s().engine.missing });
      return false;
    }
    this.location = loc;
    this.logger.info(`使用引擎：${loc.path}（来源：${loc.source}）`);
    const client = new EngineClient(loc.path, this.logger);
    client.on('exit', () => {
      this.setStatus({ state: 'error', message: s().engine.stopped });
    });
    try {
      client.start(this.root ?? process.cwd());
      const ping = await client.request<PingResult>('ping');
      this.logger.info(`引擎就绪 v${ping.version}（协议 ${ping.protocol}）`);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.logger.error(s().engine.startFailed(message));
      void vscode.window.showErrorMessage(s().engine.startFailed(message));
      this.setStatus({ state: 'error', message });
      return false;
    }
    this.client = client;
    return true;
  }

  private setStatus(patch: Partial<IndexStatus>): void {
    this.status = { ...this.status, ...patch };
    this.onDidChangeStatus.fire(this.status);
  }

  // ------------------------------ 缓存 ------------------------------

  cacheDirectory(): string | undefined {
    const cfg = readConfig();
    const root = this.root;
    if (!root) return undefined;
    const dir = cfg.cacheDirectory.trim() ? cfg.cacheDirectory.trim() : path.join(root, '.vscode', 'depscan-cache');
    try {
      fs.mkdirSync(dir, { recursive: true });
    } catch (err) {
      this.logger.warn(`无法创建缓存目录 ${dir}: ${String(err)}`);
      return undefined;
    }
    return dir;
  }

  cacheFile(): string | undefined {
    const dir = this.cacheDirectory();
    return dir ? path.join(dir, 'index-v1.txt') : undefined;
  }

  async clearCache(): Promise<boolean> {
    const dir = this.cacheDirectory();
    if (!dir || !fs.existsSync(dir)) return false;
    fs.rmSync(dir, { recursive: true, force: true });
    this.logger.info(`缓存已清理：${dir}`);
    return true;
  }

  // ------------------------------ 索引 ------------------------------

  async scan(forceFull = false): Promise<ScanStats | undefined> {
    const root = this.root;
    if (!root) {
      void vscode.window.showWarningMessage(s().index.noWorkspace);
      return undefined;
    }
    if (this.scanning) {
      void vscode.window.showInformationMessage(s().index.alreadyRunning);
      return undefined;
    }
    if (!(await this.ensureStarted())) return undefined;

    const cfg: DepScanConfig = readConfig();
    const cachePath = this.cacheFile();
    this.scanning = true;
    this.setStatus({ state: 'indexing', message: s().index.starting, done: 0, total: 0 });
    try {
      const stats = await this.client!.request<ScanStats>(
        'scan',
        {
          root,
          config: toEngineConfig(cfg, { cachePath, forceFull, includeExternal: true })
        },
        (p) => {
          this.setStatus({
            state: 'indexing',
            message: s().index.progress(p.done, p.total, p.file),
            done: p.done,
            total: p.total
          });
        }
      );
      this.setStatus({ state: 'ready', message: s().index.summary(stats), stats });
      this.recordCompileDbUsage(stats.compileCommandsFound ? stats.compileCommandsPath : undefined);
      this.logger.info(s().index.done(stats));
      if (stats.cacheReused) this.logger.info(s().index.cacheReused);
      for (const w of stats.warnings ?? []) this.logger.warn(w);
      this.onDidUpdateGraph.fire({ files: [], stats });
      return stats;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.setStatus({ state: 'error', message: s().index.failed(message) });
      this.logger.error(s().index.failed(message));
      void vscode.window.showErrorMessage(s().index.failed(message));
      return undefined;
    } finally {
      this.scanning = false;
    }
  }

  async cancel(): Promise<void> {
    if (!this.client?.running) return;
    try {
      await this.client.request('cancel');
      this.setStatus({ state: 'idle', message: s().index.cancelled });
    } catch {
      /* 忽略取消本身引发的错误 */
    }
  }

  private scheduleUpdate(fsPath: string): void {
    const root = this.root;
    if (!root || !this.client?.running) return;
    const existing = this.debounceTimers.get(fsPath);
    if (existing) clearTimeout(existing);
    const timer = setTimeout(() => {
      this.debounceTimers.delete(fsPath);
      void this.updateFiles([fsPath]);
    }, 400);
    this.debounceTimers.set(fsPath, timer);
  }

  /** 编译数据库变化：防抖后强制整体重扫（不能只更新变化文件） */
  private scheduleCompileDbRescan(fsPath: string): void {
    if (this.compileDbTimer) clearTimeout(this.compileDbTimer);
    this.compileDbTimer = setTimeout(() => {
      this.compileDbTimer = undefined;
      if (!this.client?.running) return;
      this.logger.info(s().index.compileDbChanged);
      this.logger.info(`编译数据库：${fsPath}`);
      void vscode.window.showInformationMessage(s().index.compileDbChanged);
      void this.scan(true);
    }, 800);
  }

  private recordCompileDbUsage(compdbPath: string | undefined): void {
    if (!compdbPath) {
      this.compileDbUsed = undefined;
      return;
    }
    const abs = path.resolve(compdbPath);
    this.compileDbUsed = { path: abs, mtimeMs: fileMtimeMs(abs) };
  }

  /**
   * 编译数据库是否已经比「上次扫描时生效的那份」更新。
   *
   * 只有整体重扫才能把它带来的精度提升体现出来 —— 面板的「⟳ 重新加载」
   * 原本只重新取一次子图，用户编译完再刷新当然还是看到旧的「近似」。
   */
  compileDbIsStale(): boolean {
    const root = this.root;
    if (!root) return false;
    const now = findCompileCommands(root);
    if (!now.path) return false; // 依旧没有编译数据库，重扫也不会变
    if (!this.compileDbUsed) return true; // 从无到有
    if (path.resolve(now.path) !== this.compileDbUsed.path) return true; // 换了一份
    return now.mtimeMs > this.compileDbUsed.mtimeMs + 1; // 同一份被重新生成
  }

  /** 需要时整体重扫；返回是否真的重扫了 */
  async refreshCompileDbIfNeeded(): Promise<boolean> {
    if (!this.compileDbIsStale()) return false;
    this.logger.info(s().index.compileDbChanged);
    const stats = await this.scan(true);
    if (stats) this.logger.info(s().index.precisionNow(precisionLabel(stats.precision)));
    return true;
  }

  /** 上次扫描生效的编译数据库路径（诊断用） */
  get compileDbInUse(): { path: string; mtimeMs: number } | undefined {
    return this.compileDbUsed;
  }

  /** 增量更新：只重算变化的文件，并重建受影响子图 */
  async updateFiles(fsPaths: string[]): Promise<void> {
    const root = this.root;
    if (!root || fsPaths.length === 0 || this.scanning || !this.client?.running) return;
    const cfg = readConfig();
    const rels = fsPaths
      .filter((p) => p.startsWith(root))
      .map((p) => path.relative(root, p).replace(/\\/g, '/'));
    if (rels.length === 0) return;

    try {
      let stats: ScanStats | undefined;
      for (const rel of rels) {
        const res = await this.client.request<{ updated: boolean; stats: ScanStats }>('updateFile', {
          file: rel,
          config: toEngineConfig(cfg, { cachePath: this.cacheFile() })
        });
        stats = res.stats;
      }
      if (stats) {
        this.setStatus({ state: 'ready', message: s().index.summary(stats), stats });
        this.onDidUpdateGraph.fire({ files: rels, stats });
        this.logger.debug(s().index.incremental(rels.join(', '), rels.length));
      }
    } catch (err) {
      this.logger.warn(`增量更新失败：${String(err)}`);
    }
  }

  // ------------------------------ 查询 ------------------------------

  private async requireStats(): Promise<boolean> {
    if (!(await this.ensureStarted())) return false;
    return true;
  }

  async subgraph(focus: string, depth: number, direction: Direction): Promise<SubgraphResult | undefined> {
    if (!(await this.requireStats())) return undefined;
    const cfg = readConfig();
    try {
      return await this.client!.request<SubgraphResult>('subgraph', {
        focus,
        depth,
        direction,
        maxNodes: cfg.graphMaxNodes
      });
    } catch (err) {
      this.logger.warn(`子图查询失败：${String(err)}`);
      return undefined;
    }
  }

  async symbolGraph(
    relFile: string,
    line: number,
    depth: number,
    direction: Direction
  ): Promise<SubgraphResult | undefined> {
    if (!(await this.requireStats())) return undefined;
    const cfg = readConfig();
    try {
      return await this.client!.request<SubgraphResult>('symbolGraph', {
        file: relFile,
        line,
        depth,
        direction,
        maxNodes: cfg.graphMaxNodes
      });
    } catch (err) {
      this.logger.warn(`符号图查询失败：${String(err)}`);
      return undefined;
    }
  }

  async fileGraph(relFile: string, depth: number, direction: Direction): Promise<SubgraphResult | undefined> {
    if (!(await this.requireStats())) return undefined;
    const cfg = readConfig();
    try {
      return await this.client!.request<SubgraphResult>('fileDeps', {
        file: relFile,
        depth,
        direction,
        maxNodes: cfg.graphMaxNodes
      });
    } catch (err) {
      this.logger.warn(`文件依赖查询失败：${String(err)}`);
      return undefined;
    }
  }

  async expand(focus: string, depth: number, direction: Direction): Promise<GraphData | undefined> {
    const res = await this.subgraph(focus, depth, direction);
    return res?.graph;
  }

  async architecture(): Promise<SubgraphResult | undefined> {
    if (!(await this.requireStats())) return undefined;
    try {
      return await this.client!.request<SubgraphResult>('architecture', { maxNodes: 200 });
    } catch (err) {
      this.logger.warn(`架构视图查询失败：${String(err)}`);
      return undefined;
    }
  }

  async exportData(
    format: 'json' | 'dot' | 'mermaid',
    focus: string | undefined,
    depth: number,
    direction: Direction
  ): Promise<ExportResult | undefined> {
    if (!(await this.requireStats())) return undefined;
    try {
      return await this.client!.request<ExportResult>('exportData', { format, focus, depth, direction });
    } catch (err) {
      this.logger.warn(`导出失败：${String(err)}`);
      return undefined;
    }
  }

  /** 当前编辑器位置对应的相对路径（未索引/不支持时返回 undefined） */
  activeRelFile(): { rel: string; line: number } | undefined {
    const editor = vscode.window.activeTextEditor;
    const root = this.root;
    if (!editor || !root) return undefined;
    const fsPath = editor.document.uri.fsPath;
    if (!SUPPORTED.test(fsPath) || !fsPath.startsWith(root)) return undefined;
    return {
      rel: path.relative(root, fsPath).replace(/\\/g, '/'),
      line: editor.selection.active.line + 1
    };
  }

  toRelPath(fsPath: string): string | undefined {
    const root = this.root;
    if (!root || !fsPath.startsWith(root)) return undefined;
    return path.relative(root, fsPath).replace(/\\/g, '/');
  }

  dispose(): void {
    for (const timer of this.debounceTimers.values()) clearTimeout(timer);
    this.debounceTimers.clear();
    for (const d of this.disposables) d.dispose();
    this.client?.dispose();
    this.onDidChangeStatus.dispose();
    this.onDidUpdateGraph.dispose();
  }
}
