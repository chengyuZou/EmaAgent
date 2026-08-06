// 统一管理 Bash 的 15 秒结果转交、后台公平队列、日志与终态。

import crypto from 'node:crypto';
import {
  asBackgroundProcessId,
  type BackgroundProcessId,
  type SessionId,
  type TurnId,
} from '@ema-agent/ids';
import type {
  CommandProcessHandle,
  CommandRunResult,
} from '@ema-agent/sandbox';
import { BackgroundProcessError, createBackgroundProcessAbortError } from '../errors.js';
import type {
  BackgroundProcessRecord,
  BackgroundProcessStore,
} from './backgroundProcessStore.js';
import { BackgroundProcessScheduler } from './backgroundProcessScheduler.js';
import {
  BackgroundProcessOutputStore,
  decodeOutputCursor,
  encodeOutputCursor,
  type BackgroundProcessOutputWriter,
} from './outputStore.js';
import type { BackgroundProcessEvent } from './events.js';
import type {
  BackgroundCommandRequest,
  BackgroundCommandResult,
  BackgroundProcessListOptions,
  BackgroundProcessOutput,
  BackgroundProcessOutputLocationResolver,
  BackgroundProcessOutputOptions,
  BackgroundProcessOutputPathFactory,
  BackgroundProcessCompletion,
  BackgroundProcessCompletionClaim,
  BackgroundProcessCompletionSource,
  BackgroundProcessPort,
  BackgroundProcessSettings,
  BackgroundProcessStatus,
  BackgroundProcessSummary,
} from './types.js';

const IMMEDIATE_RESULT_WAIT_MS = 15_000;
/** 交互命令的独立小池:最多 15s 即完成或转交,与后台长任务互不饿死。 */
const INTERACTIVE_MAX_CONCURRENT = 4;

interface ActiveProcess {
  request: BackgroundCommandRequest;
  writer: BackgroundProcessOutputWriter;
  handle: CommandProcessHandle;
  /** 交互快速路径不落 DB;15s 转交或队列启动后才为 true。 */
  persisted: boolean;
  version?: number;
  startedAt: number;
  detachWaitAbort?: () => void;
  terminalIntent?: 'stopped' | 'interrupted';
  /** 归还本进程占用的调度坑位;15s 转交后台后置为空操作(不再计入任何池)。 */
  releaseSlot: () => void;
}

interface QueuedProcess {
  request: BackgroundCommandRequest;
  writer: BackgroundProcessOutputWriter;
  version: number;
}

export interface BackgroundProcessRuntimeDeps {
  /** 持久化窄端口;SQL 实现由 Core 装配注入。 */
  store: BackgroundProcessStore;
  /** 创建期:按 Session 与进程 id 推导日志位置。 */
  outputPath: BackgroundProcessOutputPathFactory;
  /** 读取期:以行内存储的相对路径为唯一事实源解析绝对位置。 */
  resolveOutputLocation: BackgroundProcessOutputLocationResolver;
  settings: () => Readonly<BackgroundProcessSettings>;
  emit?: (event: BackgroundProcessEvent) => void;
  /** 交互等待上限,默认 15s;仅测试用更短值。 */
  immediateResultWaitMs?: number;
}

export class BackgroundProcessRuntime
implements BackgroundProcessPort, BackgroundProcessCompletionSource {
  private readonly output: BackgroundProcessOutputStore;
  /** 交互命令(15s 内完成或转交)的独立坑位池。 */
  private readonly interactiveScheduler: BackgroundProcessScheduler;
  /** 持久后台任务的坑位池,上限来自用户设置。 */
  private readonly backgroundScheduler: BackgroundProcessScheduler;
  private readonly active = new Map<BackgroundProcessId, ActiveProcess>();
  private readonly queued = new Map<BackgroundProcessId, QueuedProcess>();
  private readonly changeWaiters = new Map<BackgroundProcessId, Set<() => void>>();
  private shuttingDown = false;
  private completionListener?: (sessionId: SessionId) => void;

  constructor(private readonly deps: BackgroundProcessRuntimeDeps) {
    this.output = new BackgroundProcessOutputStore(deps.outputPath);
    this.interactiveScheduler = new BackgroundProcessScheduler(
      () => INTERACTIVE_MAX_CONCURRENT,
    );
    this.backgroundScheduler = new BackgroundProcessScheduler(
      () => deps.settings().maxConcurrent,
    );
  }

  recoverInterrupted(): BackgroundProcessSummary[] {
    return this.deps.store.recoverInterrupted(Date.now()).map(record => {
      this.emitRow(record);
      return this.toSummary(record);
    });
  }

  setCompletionListener(listener?: (sessionId: SessionId) => void): void {
    this.completionListener = listener;
    if (!listener) return;
    for (const sessionId of this.pendingCompletionSessions()) {
      listener(sessionId);
    }
  }

  pendingCompletionSessions(): SessionId[] {
    return this.deps.store.listSessionsWithPendingCompletions();
  }

  claimCompletionBatch(
    sessionId: SessionId,
    continuationTurnId: TurnId,
  ): BackgroundProcessCompletionClaim | undefined {
    const records = this.deps.store.claimCompletionBatch(
      sessionId,
      continuationTurnId,
      Date.now(),
    );
    const claimedTurnId = records[0]?.continuationTurnId;
    if (!claimedTurnId) return undefined;
    return {
      continuationTurnId: claimedTurnId,
      completions: records.map((record) => {
        const output = this.output.read(
          this.locationFor(record),
          { stdoutOffset: 0, stderrOffset: 0 },
          false,
        );
        return {
          processId: record.id,
          ...(record.originTurnId ? { originTurnId: record.originTurnId } : {}),
          status: record.status as BackgroundProcessCompletion['status'],
          ...(record.exitCode !== undefined ? { exitCode: record.exitCode } : {}),
          command: record.command,
          outputPreview: formatCompletionOutput(output.stdout, output.stderr),
        };
      }),
    };
  }

  markCompletionDelivered(continuationTurnId: TurnId): number {
    return this.deps.store.markCompletionDelivered(continuationTurnId, Date.now());
  }

  /**
   * 执行一条命令。两条路径:
   * runInBackground=true → 直接落库排队,立即返回 processReference;
   * 否则先占交互坑位 spawn,15 秒内完成则返回普通结果,超时则把结果所有权
   * 转交后台(detach 取消信号、交还坑位),后续终态由完成通知链接管。
   */
  async runCommand(request: BackgroundCommandRequest): Promise<BackgroundCommandResult> {
    if (this.shuttingDown) {
      throw new BackgroundProcessError('shutting_down', 'Background process runtime is shutting down');
    }
    const id = asBackgroundProcessId(crypto.randomUUID());
    const writer = this.output.create(request.sessionId, id);
    const timeoutMs = this.resolveTimeout(request.timeoutMs);
    // 进度透传只在调用存活期有效:本函数一旦返回/抛出(包括转交后台),
    // 调用方的 onProgress 通道随之关闭,进程后续输出只进日志。
    let forwardToCaller = true;
    const callerOutput = request.onOutput;
    const frozenRequest = Object.freeze({
      ...request,
      timeoutMs,
      ...(callerOutput
        ? { onOutput: (chunk: Parameters<NonNullable<typeof callerOutput>>[0]) => {
            if (forwardToCaller) callerOutput(chunk);
          } }
        : {}),
    });
    try {
      return await this.runCommandInner(id, writer, request, frozenRequest);
    } finally {
      forwardToCaller = false;
    }
  }

  private async runCommandInner(
    id: BackgroundProcessId,
    writer: BackgroundProcessOutputWriter,
    request: BackgroundCommandRequest,
    frozenRequest: BackgroundCommandRequest & { timeoutMs: number },
  ): Promise<BackgroundCommandResult> {

    if (request.runInBackground) {
      const record = this.deps.store.insert({
        id,
        sessionId: request.sessionId,
        originTurnId: request.turnId,
        toolCallId: request.toolCallId,
        command: request.command,
        description: request.description,
        cwd: request.cwd,
        status: 'queued',
        timeoutMs: frozenRequest.timeoutMs,
        outputRelativePath: writer.location.relativeDirectory,
        createdAt: Date.now(),
      });
      this.queued.set(id, { request: frozenRequest, writer, version: record.version });
      this.enqueuePersistent(id);
      this.emitRow(record);
      return {
        kind: 'processReference',
        backgroundProcessId: id,
        status: this.active.has(id) ? 'running' : 'queued',
        outputPreview: 'Command accepted by the background process queue.',
        outputRelativePath: writer.location.relativeDirectory,
      };
    }

    try {
      await this.acquireInteractiveSlot(id, request.sessionId, request.waitSignal);
    } catch (error) {
      writer.close();
      this.output.remove(writer.location);
      throw error;
    }
    if (request.waitSignal.aborted) {
      writer.close();
      this.output.remove(writer.location);
      this.interactiveScheduler.release();
      throw createBackgroundProcessAbortError();
    }

    let active: ActiveProcess;
    try {
      active = this.startProcess(id, frozenRequest, writer, false, true);
      active.releaseSlot = () => this.interactiveScheduler.release();
    } catch (error) {
      writer.close();
      this.output.remove(writer.location);
      this.interactiveScheduler.release();
      throw error;
    }

    const transfer = Symbol('transfer');
    let winner: CommandRunResult | typeof transfer;
    try {
      winner = await Promise.race([
        active.handle.completion,
        delay(this.deps.immediateResultWaitMs ?? IMMEDIATE_RESULT_WAIT_MS, transfer),
      ]);
    } catch (error) {
      active.detachWaitAbort?.();
      this.active.delete(id);
      writer.close();
      this.output.remove(writer.location);
      this.interactiveScheduler.release();
      this.notifyChanged(id);
      throw error;
    }

    if (winner !== transfer) {
      active.detachWaitAbort?.();
      this.active.delete(id);
      writer.close();
      this.output.remove(writer.location);
      this.interactiveScheduler.release();
      this.notifyChanged(id);
      return {
        kind: 'commandResult',
        result: winner,
        durationMs: Date.now() - active.startedAt,
      };
    }

    // 计时器胜出不等于可以转交:竞速期间用户可能已取消,而进程停止慢于计时器。
    // 已取消的命令绝不能登记为后台进程——等它死透再清理,Windows 句柄不挡删。
    if (request.waitSignal.aborted) {
      active.handle.stop();
      active.detachWaitAbort?.();
      this.active.delete(id);
      await active.handle.completion.catch(() => undefined);
      writer.close();
      this.output.remove(writer.location);
      this.interactiveScheduler.release();
      this.notifyChanged(id);
      throw createBackgroundProcessAbortError();
    }

    // 结果所有权已转交后台:从此不再响应原 Turn 的取消信号。
    // 同时交还交互坑位;转交出去的进程不再计入任何调度池。
    active.detachWaitAbort?.();
    active.detachWaitAbort = undefined;
    active.releaseSlot();
    active.releaseSlot = () => undefined;
    const record = this.deps.store.insert({
      id,
      sessionId: request.sessionId,
      originTurnId: request.turnId,
      toolCallId: request.toolCallId,
      command: request.command,
      description: request.description,
      cwd: request.cwd,
      status: 'running',
      timeoutMs: frozenRequest.timeoutMs,
      outputRelativePath: writer.location.relativeDirectory,
      createdAt: active.startedAt,
      startedAt: active.startedAt,
      stdoutBytes: writer.stdoutBytes,
      stderrBytes: writer.stderrBytes,
      outputTruncated: writer.truncated,
    });
    active.persisted = true;
    active.version = record.version;
    this.emitRow(record);
    void this.finishActive(id, active);
    return {
      kind: 'processReference',
      backgroundProcessId: id,
      status: 'running',
      outputPreview:
        `Command is still running; ${writer.stdoutBytes + writer.stderrBytes} output bytes captured.`,
      outputRelativePath: writer.location.relativeDirectory,
    };
  }

  list(
    sessionId: SessionId,
    options: BackgroundProcessListOptions = {},
  ): BackgroundProcessSummary[] {
    return this.deps.store.listForSession(sessionId, options)
      .map(record => this.toSummary(record));
  }

  async readOutput(
    sessionId: SessionId,
    id: BackgroundProcessId,
    options: BackgroundProcessOutputOptions = {},
  ): Promise<BackgroundProcessOutput> {
    let record = this.requireOwned(sessionId, id);
    const cursor = decodeOutputCursor(options.cursor);
    let chunk = this.output.read(this.locationFor(record), cursor, isLive(record.status));

    const waitMs = Math.min(Math.max(options.waitMs ?? 0, 0), 30_000);
    if (waitMs > 0 && !chunk.stdout && !chunk.stderr && isLive(record.status)) {
      await this.waitForChange(id, waitMs);
      record = this.requireOwned(sessionId, id);
      chunk = this.output.read(this.locationFor(record), cursor, isLive(record.status));
    }

    return {
      process: this.toSummary(record),
      stdout: chunk.stdout,
      stderr: chunk.stderr,
      nextCursor: encodeOutputCursor({
        stdoutOffset: chunk.stdoutOffset,
        stderrOffset: chunk.stderrOffset,
      }),
      hasMore: chunk.hasMore,
    };
  }

  /**
   * 停止指定进程。排队中的同步落终态;运行中的等待进程退出后再返回,
   * 调用方拿到的始终是真实终态快照,不是"停止前的 running"。
   */
  async stop(sessionId: SessionId, id: BackgroundProcessId): Promise<BackgroundProcessSummary> {
    const record = this.requireOwned(sessionId, id);
    if (!isLive(record.status)) return this.toSummary(record);

    const queued = this.queued.get(id);
    if (queued) {
      this.backgroundScheduler.cancel(id, new BackgroundProcessError('stopped_before_start', 'Background process stopped before start'));
      this.queued.delete(id);
      queued.writer.close();
      const terminal = this.deps.store.finish(id, record.version, {
        status: 'stopped',
        completedAt: Date.now(),
        terminationReason: 'Stopped by user',
        stdoutBytes: queued.writer.stdoutBytes,
        stderrBytes: queued.writer.stderrBytes,
        outputTruncated: queued.writer.truncated,
      });
      if (!terminal) throw new BackgroundProcessError('state_changed_before_stop', 'Background process state changed before stop');
      this.emitRow(terminal);
      this.notifyChanged(id);
      return this.toSummary(terminal);
    }

    const active = this.active.get(id);
    if (!active) {
      throw new BackgroundProcessError('not_attached', 'Background process is no longer attached to this application process');
    }
    active.terminalIntent = 'stopped';
    active.handle.stop();
    // finishActive 的 await 注册早于本调用,进程死亡后它先完成终态落库,
    // 这里再读到的就是真实终态。
    await active.handle.completion.catch(() => undefined);
    return this.toSummary(this.requireOwned(sessionId, id));
  }

  /**
   * Session 永久删除前关闭日志句柄、停止进程树并等待退出,
   * 避免 Windows 因子进程仍持有日志句柄而无法删除 Session 目录。
   * 数据库行随后由 Session 外键级联删除。
   */
  async discardSession(sessionId: SessionId): Promise<void> {
    for (const [id, queued] of this.queued) {
      if (queued.request.sessionId !== sessionId) continue;
      this.backgroundScheduler.cancel(id, new BackgroundProcessError('session_deleted', 'Session deleted'));
      this.queued.delete(id);
      queued.writer.close();
      this.notifyChanged(id);
    }
    const completions: Promise<CommandRunResult>[] = [];
    for (const [id, active] of this.active) {
      if (active.request.sessionId !== sessionId) continue;
      active.terminalIntent = 'interrupted';
      active.writer.close();
      active.handle.stop();
      completions.push(active.handle.completion);
      this.notifyChanged(id);
    }
    await Promise.allSettled(completions);
  }

  async shutdown(): Promise<void> {
    this.shuttingDown = true;
    this.completionListener = undefined;
    for (const [id, queued] of this.queued) {
      const record = this.deps.store.findById(id);
      this.backgroundScheduler.cancel(id, new BackgroundProcessError('app_shutting_down', 'Application is shutting down'));
      queued.writer.close();
      if (record) {
        const terminal = this.deps.store.finish(id, record.version, {
          status: 'interrupted',
          completedAt: Date.now(),
          terminationReason: 'Application is shutting down',
          stdoutBytes: queued.writer.stdoutBytes,
          stderrBytes: queued.writer.stderrBytes,
          outputTruncated: queued.writer.truncated,
        });
        if (terminal) this.emitRow(terminal);
      }
    }
    this.queued.clear();
    const completions: Promise<CommandRunResult>[] = [];
    for (const active of this.active.values()) {
      active.terminalIntent = 'interrupted';
      active.handle.stop();
      completions.push(active.handle.completion);
    }
    await Promise.allSettled(completions);
  }

  private enqueuePersistent(id: BackgroundProcessId): void {
    const queued = this.queued.get(id);
    if (!queued) return;
    this.backgroundScheduler.enqueue(queued.request.sessionId, {
      id,
      start: () => {
        const current = this.queued.get(id);
        if (!current) {
          this.backgroundScheduler.release();
          return;
        }
        this.queued.delete(id);
        const startedAt = Date.now();
        const record = this.deps.store.transitionToRunning(id, current.version, startedAt);
        if (!record) {
          current.writer.close();
          this.backgroundScheduler.release();
          return;
        }
        try {
          const active = this.startProcess(id, current.request, current.writer, true, false);
          active.releaseSlot = () => this.backgroundScheduler.release();
          active.version = record.version;
          this.emitRow(record);
          void this.finishActive(id, active);
        } catch (error) {
          current.writer.close();
          this.backgroundScheduler.release();
          const failed = this.deps.store.finish(id, record.version, {
            status: 'failed',
            completedAt: Date.now(),
            terminationReason: error instanceof Error ? error.message : String(error),
            stdoutBytes: current.writer.stdoutBytes,
            stderrBytes: current.writer.stderrBytes,
            outputTruncated: current.writer.truncated,
          });
          if (failed) {
            this.emitRow(failed);
            this.completionListener?.(failed.sessionId);
          }
          this.notifyChanged(id);
        }
      },
      // 持久队列项的取消清理由调用方(stop/discardSession/shutdown)各自完成,此处无需动作。
      cancel: () => undefined,
    });
  }

  private acquireInteractiveSlot(
    id: BackgroundProcessId,
    sessionId: SessionId,
    signal: AbortSignal,
  ): Promise<void> {
    return new Promise((resolve, reject) => {
      const onAbort = (): void => {
        if (this.interactiveScheduler.cancel(id, createBackgroundProcessAbortError())) {
          reject(createBackgroundProcessAbortError());
        }
      };
      signal.addEventListener('abort', onAbort, { once: true });
      this.interactiveScheduler.enqueue(sessionId, {
        id,
        start: () => {
          signal.removeEventListener('abort', onAbort);
          resolve();
        },
        cancel: error => {
          signal.removeEventListener('abort', onAbort);
          reject(error);
        },
      });
    });
  }

  private startProcess(
    id: BackgroundProcessId,
    request: BackgroundCommandRequest,
    writer: BackgroundProcessOutputWriter,
    persisted: boolean,
    bindWaitSignal: boolean,
  ): ActiveProcess {
    const startedAt = Date.now();
    const handle = request.runner.start(request.command, {
      cwd: request.cwd,
      timeoutMs: request.timeoutMs,
      onOutput: chunk => {
        writer.append(chunk);
        // 交互期把增量透传给调用方(进度展示);转交后台后由调用方关闭通道。
        request.onOutput?.(chunk);
        this.notifyChanged(id);
      },
    });
    let detachWaitAbort: (() => void) | undefined;
    if (bindWaitSignal) {
      const onAbort = (): void => handle.stop();
      request.waitSignal.addEventListener('abort', onAbort, { once: true });
      detachWaitAbort = () => request.waitSignal.removeEventListener('abort', onAbort);
    }
    const active: ActiveProcess = {
      request,
      writer,
      handle,
      persisted,
      startedAt,
      // 占位空操作;调用方按坑位来源(交互池/后台池)覆盖为真正的归还函数。
      releaseSlot: () => undefined,
      ...(detachWaitAbort ? { detachWaitAbort } : {}),
    };
    this.active.set(id, active);
    return active;
  }

  private async finishActive(id: BackgroundProcessId, active: ActiveProcess): Promise<void> {
    let result: CommandRunResult;
    try {
      result = await active.handle.completion;
    } catch (error) {
      result = {
        stdout: '',
        stderr: error instanceof Error ? error.message : String(error),
        exitCode: -1,
        timedOut: false,
        truncated: false,
        aborted: false,
      };
    }
    active.detachWaitAbort?.();
    active.writer.close();
    this.active.delete(id);
    active.releaseSlot();

    if (!active.persisted || active.version === undefined) {
      this.notifyChanged(id);
      return;
    }
    const status = terminalStatus(active, result);
    const record = this.deps.store.finish(id, active.version, {
      status,
      completedAt: Date.now(),
      exitCode: result.exitCode,
      terminationReason: terminalReason(active, result),
      stdoutBytes: active.writer.stdoutBytes,
      stderrBytes: active.writer.stderrBytes,
      outputTruncated: active.writer.truncated,
    });
    if (record) {
      this.emitRow(record);
      if (isNotifiable(record.status)) {
        this.completionListener?.(record.sessionId);
      }
    }
    this.notifyChanged(id);
  }

  private resolveTimeout(requested?: number): number {
    const max = this.deps.settings().maxRuntimeHours * 60 * 60 * 1_000;
    return Math.min(Math.max(requested ?? max, 1_000), max);
  }

  private requireOwned(sessionId: SessionId, id: BackgroundProcessId): BackgroundProcessRecord {
    const record = this.deps.store.findById(id);
    if (!record || record.sessionId !== sessionId) {
      throw new BackgroundProcessError('not_found', 'Background process not found in the current Session');
    }
    return record;
  }

  /** 日志位置以行内存储的相对路径为唯一事实源,解析到当前数据目录。 */
  private locationFor(record: BackgroundProcessRecord) {
    return this.deps.resolveOutputLocation(record.outputRelativePath);
  }

  private toSummary(record: BackgroundProcessRecord): BackgroundProcessSummary {
    const end = record.completedAt ?? Date.now();
    return {
      id: record.id,
      sessionId: record.sessionId,
      ...(record.originTurnId ? { originTurnId: record.originTurnId } : {}),
      ...(record.toolCallId ? { toolCallId: record.toolCallId } : {}),
      command: record.command,
      ...(record.description ? { description: record.description } : {}),
      cwd: record.cwd,
      status: record.status,
      createdAt: record.createdAt,
      ...(record.startedAt !== undefined ? { startedAt: record.startedAt } : {}),
      ...(record.completedAt !== undefined ? { completedAt: record.completedAt } : {}),
      // 时长只计运行期;排队等待不计(queued 尚无 startedAt,时长为 0)。
      durationMs: record.startedAt === undefined
        ? 0
        : Math.max(0, end - record.startedAt),
      ...(record.exitCode !== undefined ? { exitCode: record.exitCode } : {}),
      ...(record.terminationReason
        ? { terminationReason: record.terminationReason }
        : {}),
      stdoutBytes: record.stdoutBytes,
      stderrBytes: record.stderrBytes,
      outputTruncated: record.outputTruncated,
      outputDir: this.locationFor(record).absoluteDirectory,
    };
  }

  private emitRow(record: BackgroundProcessRecord): void {
    this.deps.emit?.({
      type: 'background_process_changed',
      sessionId: record.sessionId,
      backgroundProcessId: record.id,
      ...(record.originTurnId ? { originTurnId: record.originTurnId } : {}),
      ...(record.toolCallId ? { toolCallId: record.toolCallId } : {}),
      status: record.status,
      changedAt: record.completedAt ?? record.startedAt ?? record.createdAt,
      ...(record.exitCode !== undefined ? { exitCode: record.exitCode } : {}),
      ...(record.terminationReason
        ? { terminationReason: record.terminationReason }
        : {}),
    });
  }

  private notifyChanged(id: BackgroundProcessId): void {
    const waiters = this.changeWaiters.get(id);
    if (!waiters) return;
    this.changeWaiters.delete(id);
    for (const resolve of waiters) resolve();
  }

  private waitForChange(id: BackgroundProcessId, waitMs: number): Promise<void> {
    return new Promise(resolve => {
      const waiters = this.changeWaiters.get(id) ?? new Set<() => void>();
      let timer: ReturnType<typeof setTimeout>;
      const finish = (): void => {
        clearTimeout(timer);
        waiters.delete(finish);
        if (waiters.size === 0) this.changeWaiters.delete(id);
        resolve();
      };
      waiters.add(finish);
      this.changeWaiters.set(id, waiters);
      timer = setTimeout(finish, waitMs);
      timer.unref?.();
    });
  }
}

function terminalStatus(
  active: ActiveProcess,
  result: CommandRunResult,
): 'completed' | 'failed' | 'timedOut' | 'stopped' | 'interrupted' {
  if (active.terminalIntent) return active.terminalIntent;
  if (result.timedOut) return 'timedOut';
  return active.request.isSuccessfulExitCode(result.exitCode) ? 'completed' : 'failed';
}

function terminalReason(
  active: ActiveProcess,
  result: CommandRunResult,
): string | undefined {
  if (active.terminalIntent === 'stopped') return 'Stopped by user';
  if (active.terminalIntent === 'interrupted') return 'Application is shutting down';
  if (result.timedOut) return 'Maximum runtime exceeded';
  if (!active.request.isSuccessfulExitCode(result.exitCode)) {
    return `Command exited with code ${result.exitCode}`;
  }
  return undefined;
}

function isLive(status: BackgroundProcessStatus): boolean {
  return status === 'queued' || status === 'running';
}

function isNotifiable(status: BackgroundProcessStatus): boolean {
  return status === 'completed' || status === 'failed' || status === 'timedOut';
}

function formatCompletionOutput(stdout: string, stderr: string): string {
  const sections = [
    stdout.trim() ? `stdout:\n${stdout.trim()}` : '',
    stderr.trim() ? `stderr:\n${stderr.trim()}` : '',
  ].filter(Boolean);
  const joined = sections.join('\n\n') || '(no output)';
  return joined.length <= 8_000 ? joined : `${joined.slice(0, 8_000)}\n…`;
}

function delay<T>(ms: number, value: T): Promise<T> {
  return new Promise(resolve => {
    const timer = setTimeout(() => resolve(value), ms);
    timer.unref?.();
  });
}
