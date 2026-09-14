import * as vscode from 'vscode';

import { readConfig } from './config';
import { initI18n } from './i18n';
import { IndexService } from './index/indexer';
import { Logger } from './util/log';
import { ActionsTreeProvider } from './views/actionsProvider';
import { registerCommands } from './views/commands';
import { GraphPanel } from './views/graphPanel';
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

  const actionsTree = new ActionsTreeProvider(indexer);
  const indexTree = new IndexTreeProvider(indexer);
  const dependencyTree = new DependencyTreeProvider(indexer);
  const routeTree = new RouteTreeProvider(indexer);
  const statusBar = new StatusBar(indexer);

  const routeView = vscode.window.createTreeView('depscan.routeView', {
    treeDataProvider: routeTree,
    showCollapseAll: true
  });
  routeTree.attachView(routeView);

  context.subscriptions.push(
    channel,
    indexer,
    actionsTree,
    indexTree,
    dependencyTree,
    routeTree,
    statusBar,
    routeView,
    vscode.window.registerTreeDataProvider('depscan.actionsView', actionsTree),
    vscode.window.registerTreeDataProvider('depscan.indexView', indexTree),
    vscode.window.registerTreeDataProvider('depscan.dependencyView', dependencyTree)
  );

  context.subscriptions.push(
    ...registerCommands({ context, indexer, indexTree, dependencyTree, routeTree, logger })
  );

  /**
   * 语言统一入口：配置变更 → 重算文案 → 刷新所有已渲染的 UI。
   * 命令面板标题跟随的 VS Code 显示语言，运行期无法切换，属于平台限制。
   */
  const applyLanguage = (): void => {
    const resolved = initI18n(readConfig().language, vscode.env.language);
    logger.info(`界面语言切换为: ${resolved}`);
    actionsTree.refresh();
    indexTree.refresh();
    dependencyTree.refresh();
    routeTree.repaint();
    statusBar.refresh();
    GraphPanel.currentPanel?.refreshLocalization();
  };

  context.subscriptions.push(
    indexer.onDidChangeStatus.event((status) => {
      void vscode.commands.executeCommand('setContext', 'depscan.indexing', status.state === 'indexing');
    }),
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration('depscan.ui.language')) applyLanguage();
      if (e.affectsConfiguration('depscan.log.level')) logger.setLevel(readConfig().logLevel);
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
