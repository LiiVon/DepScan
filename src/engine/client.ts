import type { ChildProcessWithoutNullStreams } from 'child_process';
import { spawn } from 'child_process';
import { EventEmitter } from 'events';
import { createInterface, type Interface } from 'readline';

import { s } from '../i18n';
import type { Logger } from '../util/log';
import type { ProgressParams } from './protocol';

interface PendingCall {
  method: string;
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  onProgress?: (p: ProgressParams) => void;
}

interface RpcResponse {
  id?: number;
  ok?: boolean;
  result?: unknown;
  error?: { message?: string };
  method?: string;
  params?: unknown;
}

/** 与 C++ 引擎的 stdio JSON-RPC 客户端（每行一个 JSON 对象） */
export class EngineClient extends EventEmitter {
  private proc: ChildProcessWithoutNullStreams | undefined;
  private rl: Interface | undefined;
  private readonly pending = new Map<number, PendingCall>();
  private nextId = 1;
  private stopping = false;
  /** 引擎 stderr 的滚动尾部，崩溃时用来给出可读原因 */
  private stderrTail: string[] = [];

  constructor(
    private readonly enginePath: string,
    private readonly logger: Logger
  ) {
    super();
  }

  get running(): boolean {
    return !!this.proc && !this.proc.killed;
  }

  start(cwd: string): void {
    if (this.running) return;
    this.stopping = false;
    this.stderrTail = [];
    this.logger.info(`启动引擎: ${this.enginePath}`);
    this.proc = spawn(this.enginePath, [], {
      cwd,
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true
    }) as ChildProcessWithoutNullStreams;

    this.rl = createInterface({ input: this.proc.stdout });
    this.rl.on('line', (line) => this.onLine(line));

    this.proc.stderr.on('data', (chunk: Buffer) => {
      const text = chunk.toString('utf8').trimEnd();
      if (!text) return;
      for (const raw of text.split(/\r?\n/)) {
        const line = raw.trimEnd();
        if (!line.trim()) continue;
        this.stderrTail.push(line);
        if (this.stderrTail.length > 40) this.stderrTail.shift();
        // 引擎的报错以前只在 debug 级别可见 —— 但崩溃时用户根本不会去开 debug，
        // 于是「引擎进程异常退出」就变成了一条没有原因的报错。
        // 凡是看起来像错误的行都按 warn 记，默认日志里就能看到。
        if (/error|failed|failure|cannot|unable|异常|失败|错误/i.test(line)) {
          this.logger.warn(`[engine] ${line}`);
        } else {
          this.logger.debug(`[engine] ${line}`);
        }
      }
    });

    this.proc.on('error', (err) => {
      this.logger.error(`引擎进程错误: ${err.message}`);
      this.failAll(new Error(s().engine.startFailed(err.message)));
    });

    this.proc.on('exit', (code, signal) => {
      const message = `code=${code ?? 'null'} signal=${signal ?? 'null'}`;
      this.logger.warn(`引擎退出 (${message})`);
      // 把崩溃前的最后几行 stderr 一起放到日志里，紧挨着退出信息，
      // 否则用户要在一个几千行的输出面板里自己找原因。
      for (const line of this.stderrTail) this.logger.warn(`[engine] ${line}`);
      this.proc = undefined;
      this.rl?.close();
      this.rl = undefined;
      const reason = this.stderrTail.length > 0 ? `\n${this.stderrTail.slice(-6).join('\n')}` : '';
      this.failAll(
        new Error(this.stopping ? s().engine.stopped : s().engine.crashed(message) + reason)
      );
      if (!this.stopping) this.emit('exit', code, signal);
    });
  }

  private onLine(line: string): void {
    const text = line.trim();
    if (!text) return;
    let msg: RpcResponse;
    try {
      msg = JSON.parse(text) as RpcResponse;
    } catch {
      this.logger.warn(`引擎输出无法解析为 JSON: ${text.slice(0, 200)}`);
      return;
    }
    if (typeof msg.id === 'number') {
      const call = this.pending.get(msg.id);
      if (!call) return;
      this.pending.delete(msg.id);
      if (msg.ok) call.resolve(msg.result);
      else call.reject(new Error(msg.error?.message ?? 'unknown engine error'));
      return;
    }
    if (msg.method === 'progress') {
      const params = msg.params as ProgressParams;
      for (const call of this.pending.values()) call.onProgress?.(params);
      this.emit('progress', params);
    }
  }

  private failAll(error: Error): void {
    for (const [, call] of this.pending) call.reject(error);
    this.pending.clear();
  }

  request<T>(method: string, params: Record<string, unknown> = {}, onProgress?: (p: ProgressParams) => void): Promise<T> {
    if (!this.proc) return Promise.reject(new Error(s().engine.notStarted));
    const id = this.nextId++;
    const payload = JSON.stringify({ id, method, params });
    return new Promise<T>((resolve, reject) => {
      this.pending.set(id, {
        method,
        resolve: resolve as (v: unknown) => void,
        reject,
        onProgress
      });
      this.proc?.stdin.write(`${payload}\n`, 'utf8', (err) => {
        if (err) {
          this.pending.delete(id);
          reject(err);
        }
      });
    });
  }

  dispose(): void {
    this.stopping = true;
    try {
      this.proc?.stdin.write(`${JSON.stringify({ id: this.nextId++, method: 'shutdown', params: {} })}\n`);
    } catch {
      /* 进程已退出时忽略 */
    }
    const proc = this.proc;
    this.proc = undefined;
    this.rl?.close();
    this.rl = undefined;
    this.failAll(new Error(s().engine.stopped));
    if (proc) {
      // 给引擎 300ms 优雅退出，否则强杀
      const timer = setTimeout(() => {
        if (!proc.killed) proc.kill();
      }, 300);
      proc.once('exit', () => clearTimeout(timer));
    }
  }
}
