import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createInterface } from 'node:readline';
import { z } from 'zod';
import { controlEventSchema, type ComputerTransport, type NativeControlState, type NativeRequest } from './types.js';
import { ComputerUseError } from './errors.js';

const replySchema = z.object({
  jsonrpc: z.literal('2.0'),
  id: z.number().int(),
  result: z.unknown().optional(),
  error: z.object({ code: z.number(), message: z.string() }).optional(),
});

interface PendingNativeRequest {
  resolve(value: unknown): void;
  reject(error: Error): void;
  // 收到回应或连接断开后, 清除这次请求的超时计时器和取消监听.
  dispose(): void;
}

/** 开发和发布构建均将程序复制到包内 bin. 缺少产物时由启动错误明确报告. */
export function resolveComputerExecutable(): string | undefined {
  if (process.platform !== 'win32') return undefined;
  return fileURLToPath(new URL('../bin/ema-computer-use.exe', import.meta.url));
}

export class NativeComputerProcess implements ComputerTransport {
  private childProcess: ChildProcessWithoutNullStreams | null = null;
  // 已发给 Rust 但还没收到回应的请求. key 是通信请求编号, 不是 ToolCallId 或 controlId.
  private readonly pendingRequests = new Map<number, PendingNativeRequest>();
  // Rust 主动通知启动/结束时调用. 普通请求的回应走 pendingRequests.
  private readonly computerUseStateListeners = new Set<(state: NativeControlState) => void>();
  // 给下一条发往 Rust 的请求编号. Rust 回同一个编号, Node 才知道该完成哪个 Promise.
  private nextRequestId = 1;
  // 当前这一整段电脑操控的 ID, 从批准启动到 Esc, 结束按钮或 ComputerEnd 为止.
  // Rust 突然退出时, 用它通知 ComputerUse 结束这段操控, 让主 Agent 不再等继续.
  private currentActiveComputerUseId: string | null = null;
  private isClosed = false;

  constructor(private readonly executable: string) {}

  subscribe(listener: (state: NativeControlState) => void): () => void {
    this.computerUseStateListeners.add(listener);
    return () => { this.computerUseStateListeners.delete(listener); };
  }

  request(request: NativeRequest, signal: AbortSignal): Promise<unknown> {
    signal.throwIfAborted();
    if (this.isClosed) return Promise.reject(new ComputerUseError('computer/closed', 'Computer control is closed.'));
    const childProcess = this.ensureProcess();
    const id = this.nextRequestId++;
    return new Promise((resolve, reject) => {
      const abort = () => {
        // 立刻告诉 Rust 取消这个请求, 但仍等 Rust 回应, 才能知道是否已经输入了一部分.
        if (!this.pendingRequests.has(id)) return;
        childProcess.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'computer.cancel', params: { id } })}\n`);
      };
      const timeout = setTimeout(() => {
        this.fail(new ComputerUseError('tool/outcome_unknown', 'The native computer request timed out. Its result may be partial.', 'possible'));
        childProcess.kill();
      }, 30_000);
      this.pendingRequests.set(id, {
        resolve,
        reject,
        dispose: () => {
          clearTimeout(timeout);
          signal.removeEventListener('abort', abort);
        },
      });
      signal.addEventListener('abort', abort, { once: true });
      childProcess.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, ...request })}\n`, error => {
        if (error) this.fail(error);
      });
      if (signal.aborted) abort();
    });
  }

  async close(): Promise<void> {
    this.isClosed = true;
    const childProcess = this.childProcess;
    if (!childProcess) return;
    await new Promise<void>(resolve => {
      const timer = setTimeout(() => { childProcess.kill(); }, 2000);
      childProcess.once('close', () => {
        clearTimeout(timer);
        resolve();
      });
      childProcess.stdin.end();
    });
  }

  private ensureProcess(): ChildProcessWithoutNullStreams {
    if (this.childProcess) return this.childProcess;
    const childProcess = spawn(this.executable, [], { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
    this.childProcess = childProcess;
    childProcess.stdin.on('error', error => {
      this.fail(error);
      childProcess.kill();
    });
    const lines = createInterface({ input: childProcess.stdout });
    lines.on('line', line => {
      try {
        const value: unknown = JSON.parse(line);
        const event = controlEventSchema.safeParse(value);
        if (event.success) {
          const state = event.data.params;
          if (state.phase === 'ended') this.currentActiveComputerUseId = null;
          else this.currentActiveComputerUseId = state.controlId;
          for (const listener of this.computerUseStateListeners) listener(state);
          return;
        }
        const reply = replySchema.parse(value);
        const pending = this.pendingRequests.get(reply.id);
        if (!pending) return;
        this.pendingRequests.delete(reply.id);
        pending.dispose();
        if (reply.error) pending.reject(new ComputerUseError('computer/native_error', reply.error.message));
        else pending.resolve(reply.result);
      } catch (error) {
        this.fail(new Error('Invalid response from native computer control.', { cause: error }));
        childProcess.kill();
      }
    });
    // 持续读取 stderr, 避免管道满后卡住 Rust. 这些内容不写入应用日志.
    childProcess.stderr.on('data', () => {});
    childProcess.on('error', error => { this.fail(error); });
    childProcess.on('close', () => {
      lines.close();
      if (this.childProcess === childProcess) this.childProcess = null;
      this.fail(new ComputerUseError('tool/outcome_unknown', 'Native computer control disconnected. Observe again before starting new work.', 'possible'));
    });
    return childProcess;
  }

  private fail(error: Error): void {
    for (const request of this.pendingRequests.values()) {
      request.dispose();
      request.reject(error);
    }
    this.pendingRequests.clear();
    if (this.currentActiveComputerUseId) {
      const controlId = this.currentActiveComputerUseId;
      this.currentActiveComputerUseId = null;
      for (const listener of this.computerUseStateListeners) listener({ controlId, phase: 'ended', reason: 'connection_closed' });
    }
  }
}
