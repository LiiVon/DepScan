import * as vscode from 'vscode';

import { readConfig } from './config';
import { initI18n } from './i18n';
import { IndexService } from './index/indexer';
import { Logger } from './util/log';
import { registerCommands } from './views/commands';
import { StatusBar } from './views/statusBar';
import { DependencyTreeProvider, IndexTreeProvider } from './views/treeProvider';

export async function activate(context: vscode.ExtensionContext): Promise<void> {
  const channel = vscode.window.createOutputChannel('DepScan');
  const cfg = readConfig();
  initI18n(cfg.language);

  const logger = new Logger(channel, cfg.logLevel);
  logger.info(`DepScan 激活（${vscode.env.language}）`);

  const indexer = new IndexService(context, logger);
  await indexer.initialize();

  const indexTree = new IndexTreeProvider(indexer);
  const dependencyTree = new DependencyTreeProvider(indexer);
  const statusBar = new StatusBar(indexer);

  context.subscriptions.push(
    channel,
    indexer,
    indexTree,
    dependencyTree,
    statusBar,
    vscode.window.registerTreeDataProvider('depscan.indexView', indexTree),
    vscode.window.registerTreeDataProvider('depscan.dependencyView', dependencyTree)
  );

  context.subscriptions.push(...registerCommands({ context, indexer, indexTree, dependencyTree, logger }));

  context.subscriptions.push(
    indexer.onDidChangeStatus.event((status) => {
      void vscode.commands.executeCommand('setContext', 'depscan.indexing', status.state === 'indexing');
    }),
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration('depscan.ui.language')) initI18n(readConfig().language);
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
