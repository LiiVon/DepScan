import * as vscode from 'vscode';

/** 输出通道日志（受 depscan.log.level 控制） */
export class Logger {
  private level: 'off' | 'error' | 'warn' | 'info' | 'debug';

  constructor(private readonly channel: vscode.OutputChannel, level: Logger['level'] = 'info') {
    this.level = level;
  }

  setLevel(level: Logger['level']): void {
    this.level = level;
  }

  private rank(l: Logger['level']): number {
    return { off: 0, error: 1, warn: 2, info: 3, debug: 4 }[l];
  }

  private write(l: 'error' | 'warn' | 'info' | 'debug', message: string): void {
    if (this.rank(this.level) < this.rank(l)) return;
    const stamp = new Date().toISOString().slice(11, 23);
    this.channel.appendLine(`[${stamp}] [${l.toUpperCase()}] ${message}`);
  }

  error(m: string): void {
    this.write('error', m);
  }
  warn(m: string): void {
    this.write('warn', m);
  }
  info(m: string): void {
    this.write('info', m);
  }
  debug(m: string): void {
    this.write('debug', m);
  }
  show(): void {
    this.channel.show(true);
  }
}
