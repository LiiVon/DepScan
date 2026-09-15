import * as path from 'path';
import * as vscode from 'vscode';

import { readConfig } from '../config';
import { precisionHint, precisionLabel, s } from '../i18n';
import type { IndexService } from '../index/indexer';
import { findCompileCommands } from '../index/compileDb';
import type { Logger } from '../util/log';
import { GraphPanel } from './graphPanel';
import { RoutePanel } from './routePanel';
import type { CandidateArgs, RouteTreeProvider } from './routeProvider';
import type { DependencyTreeProvider, IndexTreeProvider } from './treeProvider';

export interface CommandDeps {
  context: vscode.ExtensionContext;
  indexer: IndexService;
  indexTree: IndexTreeProvider;
  dependencyTree: DependencyTreeProvider;
  routeTree: RouteTreeProvider;
  logger: Logger;
}

const SUPPORTED = /\.(c|cc|cpp|cxx|c\+\+|h|hh|hpp|hxx|h\+\+|inl|ipp|tcc|inc)$/i;

export function registerCommands(deps: CommandDeps): vscode.Disposable[] {
  const { context, indexer, indexTree, dependencyTree, routeTree, logger } = deps;
  const commands: vscode.Disposable[] = [];

  /** 确保已有索引；返回是否可用 */
  const ensureIndex = async (): Promise<boolean> => {
    if (indexer.currentStatus.stats) return true;
    const stats = await indexer.scan(false);
    return !!stats;
  };

  // 打开源码位置（供侧边栏树 / 表格 / 图内点击复用）
  commands.push(
    vscode.commands.registerCommand('depscaner.openNode', async (relFile: string, line = 1, column = 1) => {
      const root = indexer.root;
      if (!root || !relFile) return;
      const abs = path.isAbsolute(relFile) ? relFile : path.join(root, relFile);
      try {
        const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(abs));
        const editor = await vscode.window.showTextDocument(doc, { preview: true });
        const position = new vscode.Position(Math.max(0, line - 1), Math.max(0, column - 1));
        editor.selection = new vscode.Selection(position, position);
        editor.revealRange(
          new vscode.Range(position, position),
          vscode.TextEditorRevealType.InCenterIfOutsideViewport
        );
      } catch (err) {
        logger.warn(`无法打开 ${abs}: ${String(err)}`);
      }
    })
  );

  // 右键 / 命令面板：查看依赖图
  commands.push(
    vscode.commands.registerCommand('depscaner.showGraph', async (uri?: vscode.Uri) => {
      const cfg = readConfig();
      const target = uri?.fsPath ?? vscode.window.activeTextEditor?.document.uri.fsPath;
      if (!target) {
        void vscode.window.showWarningMessage(s().errors.noActiveFile);
        return;
      }
      if (!SUPPORTED.test(target)) {
        void vscode.window.showWarningMessage(s().errors.unsupportedFile);
        return;
      }
      const rel = indexer.toRelPath(target);
      if (!rel) {
        void vscode.window.showWarningMessage(s().errors.noActiveFile);
        return;
      }
      dependencyTree.refresh(rel);
      if (!(await ensureIndex())) return;
      GraphPanel.createOrShow(context, indexer, logger, {
        focusId: `file:${rel}`,
        label: rel,
        depth: cfg.graphDepth,
        direction: cfg.graphDirection
      });
    })
  );

  // 当前符号（光标位置）的依赖图
  commands.push(
    vscode.commands.registerCommand('depscaner.showGraphForSymbol', async () => {
      const cfg = readConfig();
      const active = indexer.activeRelFile();
      if (!active) {
        void vscode.window.showWarningMessage(s().errors.noActiveFile);
        return;
      }
      if (!(await ensureIndex())) return;
      const result = await indexer.symbolGraph(active.rel, active.line, cfg.graphDepth, cfg.graphDirection);
      if (!result?.focus) {
        void vscode.window.showWarningMessage(s().errors.focusMissing(`${active.rel}:${active.line}`));
        return;
      }
      GraphPanel.createOrShow(context, indexer, logger, {
        focusId: result.focus,
        label: `${active.rel}:${active.line}`,
        depth: cfg.graphDepth,
        direction: cfg.graphDirection
      });
    })
  );

  // 全局架构视图（按目录聚合，无需焦点文件）
  commands.push(
    vscode.commands.registerCommand('depscaner.showArchitecture', async () => {
      if (!(await ensureIndex())) return;
      GraphPanel.createOrShow(context, indexer, logger, {
        label: s().actions.architecture,
        architecture: true
      });
    })
  );

  // 切换界面语言。只负责改配置，真正的刷新由 extension.ts 的配置变更监听统一处理。
  commands.push(
    vscode.commands.registerCommand('depscaner.setLanguage', async (language: 'auto' | 'zh' | 'en') => {
      await vscode.workspace
        .getConfiguration('depscaner')
        .update('ui.language', language, vscode.ConfigurationTarget.Global);
    })
  );

  // 阅读路线：把侧边栏该视图展开并重新生成
  commands.push(
    vscode.commands.registerCommand('depscaner.showRoute', async () => {
      if (!(await ensureIndex())) return;
      await vscode.commands.executeCommand('depscaner.routeView.focus');
      routeTree.refresh();
    })
  );

  commands.push(
    vscode.commands.registerCommand('depscaner.toggleRouteGroupByFile', async () => {
      await routeTree.toggleGroupByFile();
    })
  );

  commands.push(
    vscode.commands.registerCommand('depscaner.toggleRouteStrategy', async () => {
      await routeTree.toggleStrategy();
    })
  );

  // 降噪开关：折叠「纯转发 / 小函数」。默认开着 —— 路线是给人读的，
  // 一堆一行 getter 夹在中间只会把真正要读的那几步冲淡；
  // 但折叠不能是静默的（视图顶部会报「已折叠 N 个」），也要能随时关掉核对。
  commands.push(
    vscode.commands.registerCommand('depscaner.toggleRouteSkipTrivial', async () => {
      await routeTree.toggleSkipTrivial();
      void vscode.window.setStatusBarMessage(
        routeTree.hideTrivial ? s().route.hideTrivial : s().route.showTrivial,
        4000
      );
    })
  );

  // 阅读路线：起点取自编辑器光标所在的函数。
  // 大项目的 main 常常在平台相关文件里，真正想读的那条线未必从 main 起头；
  // 库项目则压根没有 main —— 这两种情况都靠「换个起点」解决。
  commands.push(
    vscode.commands.registerCommand('depscaner.routeFromCursor', async () => {
      const active = indexer.activeRelFile();
      if (!active) {
        void vscode.window.showWarningMessage(s().errors.noActiveFile);
        return;
      }
      // 先把视图露出来，再等索引（大项目下构图可能要几秒）
      await vscode.commands.executeCommand('depscaner.routeView.focus');
      if (!(await ensureIndex())) return;
      const node = await indexer.nodeAt(active.rel, active.line);
      if (!node?.id) {
        void vscode.window.showWarningMessage(s().route.cursorMissing(active.rel, active.line));
        return;
      }
      routeTree.setStart(node.id);
    })
  );

  commands.push(
    vscode.commands.registerCommand('depscaner.resetRouteStart', async () => {
      routeTree.setStart(undefined);
    })
  );

  // 泳道图：唯一需要画布的那部分 —— 「控制权在哪些文件之间来回」用文字讲不清
  commands.push(
    vscode.commands.registerCommand('depscaner.showRouteDiagram', async () => {
      if (!(await ensureIndex())) return;
      RoutePanel.createOrShow({ context, indexer, routeTree, logger });
    })
  );

  // 候选切换：这一步的名字在项目里还有别的定义，由用户决定该读哪一个。
  // 参数由 RouteTreeProvider 拼好（见 CandidateArgs）：parentId 为空 = 这是起点。
  commands.push(
    vscode.commands.registerCommand('depscaner.pickRouteCandidate', async (args?: CandidateArgs) => {
      if (!args) return;
      const nodeId = args.reset ? undefined : args.nodeId || undefined;
      if (!args.parentId) routeTree.setStart(nodeId);
      else routeTree.correct(args.parentId, args.name, nodeId);
    })
  );

  commands.push(
    vscode.commands.registerCommand('depscaner.indexWorkspace', async () => {
      await indexer.scan(true);
      indexTree.refresh();
      dependencyTree.refresh();
    })
  );

  commands.push(
    vscode.commands.registerCommand('depscaner.cancelIndex', async () => {
      await indexer.cancel();
    })
  );

  commands.push(
    vscode.commands.registerCommand('depscaner.clearCache', async () => {
      const ok = await indexer.clearCache();
      void vscode.window.showInformationMessage(ok ? s().cache.cleared : s().cache.none);
    })
  );

  commands.push(
    vscode.commands.registerCommand('depscaner.refreshDependencyView', () => {
      dependencyTree.refresh();
      indexTree.refresh();
    })
  );

  commands.push(
    vscode.commands.registerCommand('depscaner.showIndexStatus', async () => {
      const status = indexer.currentStatus;
      const stats = status.stats;
      const lines: string[] = [];
      lines.push(`${s().graph.focusLabel}: ${status.message || status.state}`);
      if (stats) {
        lines.push(s().index.summary(stats));
        lines.push(`${s().table.precision}: ${precisionLabel(stats.precision)}`);
        lines.push(`compile_commands: ${stats.compileCommandsFound ? stats.compileCommandsPath : '—'}`);
        for (const w of stats.warnings ?? []) lines.push(`⚠ ${w}`);
      }
      const engine = indexer.engineLocation;
      if (engine) lines.push(`engine: ${engine.path}`);
      lines.push(`cache: ${indexer.cacheFile() ?? '—'}`);
      const choice = await vscode.window.showInformationMessage(lines.join('\n'), { modal: true }, 'OK', s().diagnostic.rescan);
      if (choice) await indexer.scan(true);
    })
  );

  // 精度诊断：回答「为什么我编译了、刷新了，还是显示近似？」
  commands.push(
    vscode.commands.registerCommand('depscaner.diagnosePrecision', async () => {
      const d = s().diagnostic;
      const root = indexer.root;
      if (!root) {
        void vscode.window.showWarningMessage(s().index.noWorkspace);
        return;
      }
      const stats = indexer.currentStatus.stats;
      const lines: string[] = [d.title, ''];
      lines.push(d.project(root));

      const engine = indexer.engineLocation;
      if (engine) lines.push(d.engine(engine.path, engine.source));
      lines.push(d.libclang(stats?.libclangAvailable ?? false));

      const db = findCompileCommands(root);
      if (db.path) {
        lines.push(d.compileDb(db.path));
        if (stats?.compileCommandsFound) lines.push(d.compileDbEntries(stats.compileCommandEntries));
      } else {
        lines.push(d.compileDbMissing);
        if (db.staleBuilds.length > 0) {
          const dirs = db.staleBuilds.slice(0, 6).map((p) => `  · ${path.relative(root, p) || '.'}/`).join('\n');
          lines.push(d.buildDirWithoutDb(dirs));
        } else {
          const dirs = db.searched.slice(0, 8).map((p) => `  · ${path.relative(root, p) || '.'}/`).join('\n');
          if (dirs) lines.push(d.searched(dirs));
        }
      }

      if (stats) {
        lines.push(d.precision(precisionLabel(stats.precision), precisionHint(stats.precision)));
        lines.push(d.includes(stats.exactIncludeEdges, stats.approxIncludeEdges));
        lines.push(d.symbols(stats.exactNodes, stats.approxNodes));
        lines.push(d.cache(stats.cacheReused, indexer.cacheFile() ?? '—'));
        for (const w of stats.warnings ?? []) lines.push(`⚠ ${w}`);
      } else {
        lines.push(d.notIndexed);
      }

      lines.push('', d.nextHeader);
      if (!stats) lines.push(d.nextScan);
      const stale = indexer.compileDbIsStale();
      if (!db.path) lines.push(d.nextBuild);
      else if (stale) lines.push(d.nextRescan);
      else if (stats && stats.precision !== 'exact') lines.push(d.nextClang);
      else lines.push(d.nextOk);

      const action = await vscode.window.showInformationMessage(lines.join('\n'), {
        modal: true
      }, d.rescan, d.openGuide, 'OK');
      if (action === d.rescan) await indexer.scan(true);
      if (action === d.openGuide) await vscode.commands.executeCommand('depscaner.prepareCompileCommands');
    })
  );

  commands.push(
    vscode.commands.registerCommand('depscaner.exportJson', async () => {
      await exportWithFormat(indexer, 'json', logger);
    })
  );

  commands.push(
    vscode.commands.registerCommand('depscaner.exportImage', async () => {
      await vscode.commands.executeCommand('depscaner.showGraph');
    })
  );

  commands.push(
    vscode.commands.registerCommand('depscaner.prepareCompileCommands', async () => {
      const doc = await vscode.workspace.openTextDocument({
        content: `## ${s().compile.guideTitle}\n\n\`\`\`\n${s().compile.guideBody}\n\`\`\`\n`,
        language: 'markdown'
      });
      await vscode.window.showTextDocument(doc, { preview: true });
    })
  );

  commands.push(
    vscode.commands.registerCommand('depscaner.openDocs', async () => {
      const entry = vscode.Uri.joinPath(context.extensionUri, 'docs', '01-快速开始.md');
      try {
        await vscode.workspace.fs.stat(entry);
        await vscode.commands.executeCommand('markdown.showPreview', entry);
      } catch {
        void vscode.window.showWarningMessage(s().docs.missing);
      }
    })
  );

  return commands;
}

async function exportWithFormat(
  indexer: IndexService,
  format: 'json' | 'dot' | 'mermaid',
  logger: Logger
): Promise<void> {
  const cfg = readConfig();
  const active = indexer.activeRelFile();
  const result = await indexer.exportData(
    format,
    active ? `file:${active.rel}` : undefined,
    cfg.graphDepth,
    cfg.graphDirection
  );
  if (!result) {
    void vscode.window.showErrorMessage(s().errors.noData);
    return;
  }
  const ext = format === 'mermaid' ? 'mmd' : format;
  const root = indexer.root ?? process.cwd();
  const uri = await vscode.window.showSaveDialog({
    defaultUri: vscode.Uri.file(path.join(root, `depscaner-deps.${ext}`))
  });
  if (!uri) return;
  try {
    await vscode.workspace.fs.writeFile(uri, Buffer.from(result.content, 'utf8'));
    void vscode.window.showInformationMessage(s().graph.exported(uri.fsPath));
  } catch (err) {
    logger.error(`导出失败：${String(err)}`);
    void vscode.window.showErrorMessage(s().errors.exportFailed(String(err)));
  }
}
