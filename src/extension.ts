import * as vscode from 'vscode';

import { readConfig } from './config';
import { initI18n, s } from './i18n';
import { IndexService } from './index/indexer';
import { Logger } from './util/log';
import { ActionsTreeProvider } from './views/actionsProvider';
import { registerCommands } from './views/commands';
import { BoundaryDiagnostics } from './views/diagnostics';
import { GraphPanel } from './views/graphPanel';
import { RoutePanel } from './views/routePanel';
import { RouteTreeProvider } from './views/routeProvider';
import { StatusBar } from './views/statusBar';
import { DependencyTreeProvider, IndexTreeProvider } from './views/treeProvider';

export async function activate(context: vscode.ExtensionContext): Promise<void> {
  const channel = vscode.window.createOutputChannel('DepScan');
  const cfg = readConfig();
  initI18n(cfg.language, vscode.env.language);

  const logger = new Logger(channel, cfg.logLevel);
  logger.info(`DepScan 激活（VS Code 显示语言: ${vscode.env.language}）`);

  const indexer = new IndexService(context, logger);
  await indexer.initialize();

  const routeTree = new RouteTreeProvider(indexer);
  const actionsTree = new ActionsTreeProvider(indexer, routeTree);
  const indexTree = new IndexTreeProvider(indexer);
  const dependencyTree = new DependencyTreeProvider(indexer);
  const boundaries = new BoundaryDiagnostics(indexer, logger);
  const statusBar = new StatusBar(indexer);

  const routeView = vscode.window.createTreeView('depscan.routeView', {
    treeDataProvider: routeTree,
    showCollapseAll: true
  });
  routeTree.attachView(routeView);

  // 其余三个视图也拿句柄：标题要在运行期改（见 applyViewTitles）
  const actionsView = vscode.window.createTreeView('depscan.actionsView', {
    treeDataProvider: actionsTree
  });
  const indexView = vscode.window.createTreeView('depscan.indexView', {
    treeDataProvider: indexTree
  });
  const dependencyView = vscode.window.createTreeView('depscan.dependencyView', {
    treeDataProvider: dependencyTree
  });

  /**
   * 视图标题跟着**界面语言设置**走。
   *
   * 清单里的 `%view.x%` 只跟随 VS Code 显示语言（平台限制），但 `TreeView.title` 可以在运行期改 ——
   * 不这么做就会出现「界面全中文、只有视图标题是英文」这种半截翻译。
   * 命令面板里的命令标题仍然只能跟显示语言，那是平台行为，无法绕过。
   */
  const applyViewTitles = (): void => {
    actionsView.title = s().views.actions;
    indexView.title = s().views.index;
    dependencyView.title = s().views.dependencies;
    routeView.title = s().views.route;
  };
  applyViewTitles();

  context.subscriptions.push(
    channel,
    indexer,
    actionsTree,
    indexTree,
    dependencyTree,
    routeTree,
    boundaries,
    statusBar,
    routeView,
    actionsView,
    indexView,
    dependencyView,
    // 图变了（重新索引 / 增量更新）→ 重算边界违规：这条检查是全局属性，不能只跟增量
    indexer.onDidUpdateGraph.event(() => void boundaries.refresh())
  );

  context.subscriptions.push(
    ...registerCommands({ context, indexer, indexTree, dependencyTree, routeTree, boundaries, logger })
  );

  /**
   * 语言统一入口：配置变更 → 重算文案 → 刷新所有已渲染的 UI。
   * 命令面板标题跟随的 VS Code 显示语言，运行期无法切换，属于平台限制。
   */
  const applyLanguage = (): void => {
    const resolved = initI18n(readConfig().language, vscode.env.language);
    logger.info(`界面语言切换为: ${resolved}`);
    applyViewTitles();
    actionsTree.refresh();
    indexTree.refresh();
    dependencyTree.refresh();
    routeTree.repaint();
    statusBar.refresh();
    GraphPanel.currentPanel?.refreshLocalization();
    RoutePanel.currentPanel?.refreshLocalization();
  };

  context.subscriptions.push(
    indexer.onDidChangeStatus.event((status) => {
      void vscode.commands.executeCommand('setContext', 'depscan.indexing', status.state === 'indexing');
    }),
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration('depscan.ui.language')) applyLanguage();
      if (e.affectsConfiguration('depscan.log.level')) logger.setLevel(readConfig().logLevel);
      // 关掉开关时要把已有诊断清掉，否则面板里会留着一堆不会再更新的告警
      if (e.affectsConfiguration('depscan.checks.enabled')) void boundaries.refresh();
    })
  );

  // 打开工作区后自动后台建立索引（不阻塞编辑器）
  if (cfg.onStartup && vscode.workspace.workspaceFolders?.length) {
    setTimeout(() => {
      void indexer.scan(false);
    }, 1200);
  }
}

export function deactivate(): void {
  // 资源由 context.subscriptions 统一释放
}
