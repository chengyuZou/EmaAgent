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
import {
  type BackgroundProcessRow,
  BackgroundProcessesRepo,
} from '@ema-agent/storage';
import { BackgroundProcessScheduler } from './fairScheduler.js';
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
  BackgroundProcessOutput,
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

interface ActiveProcess {
  request: BackgroundCommandRequest;
  writer: BackgroundProcessOutputWriter;
  handle: CommandProcessHandle;
  persisted: boolean;
  version?: number;
  startedAt: number;
  detachWaitAbort?: () => void;
  terminalIntent?: 'stopped' | 'interrupted';
}

interface QueuedProcess {
  request: BackgroundCommandRequest;
  writer: BackgroundProcessOutputWriter;
  version: number;
}

export interface BackgroundProcessRuntimeDeps {
  repo: BackgroundProcessesRepo;
  outputPath: BackgroundProcessOutputPathFactory;
  settings: () => Readonly<BackgroundProcessSettings>;
  emit?: (event: BackgroundProcessEvent) => void;
}

export class BackgroundProcessRuntime
implements BackgroundProcessPort, BackgroundProcessCompletionSource {
  private readonly output: BackgroundProcessOutputStore;
  private readonly scheduler: BackgroundProcessScheduler;
  private readonly active = new Map<BackgroundProcessId, ActiveProcess>();
  private readonly queued = new Map<BackgroundProcessId, QueuedProcess>();
  private readonly changeWaiters = new Map<BackgroundProcessId, Set<() => void>>();
  private shuttingDown = false;
  private completionListener?: (sessionId: SessionId) => void;

  constructor(private readonly deps: BackgroundProcessRuntimeDeps) {
    this.output = new BackgroundProcessOutputStore(deps.outputPath);
    this.scheduler = new BackgroundProcessScheduler(
      () => deps.settings().maxConcurrent,
    );
  }

  recoverInterrupted(): BackgroundProcessSummary[] {
    return this.deps.repo.recoverInterrupted(Date.now()).map(row => {
      this.emitRow(row);
      return toSummary(row);
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
    return this.deps.repo.listSessionsWithPendingCompletions();
  }

  claimCompletionBatch(
    sessionId: SessionId,
    continuationTurnId: TurnId,
  ): BackgroundProcessCompletionClaim | undefined {
    const rows = this.deps.repo.claimCompletionBatch(
      sessionId,
      continuationTurnId,
      Date.now(),
    );
    const claimedTurnId = rows[0]?.continuation_turn_id;
    if (!claimedTurnId) return undefined;
    return {
      continuationTurnId: claimedTurnId,
      completions: rows.map((row) => {
        const output = this.output.read(
          this.locationFor(row),
          { stdoutOffset: 0, stderrOffset: 0 },
        );
        return {
          processId: row.id,
          ...(row.origin_turn_id ? { originTurnId: row.origin_turn_id } : {}),
          status: row.status as BackgroundProcessCompletion['status'],
          ...(row.exit_code !== null ? { exitCode: row.exit_code } : {}),
          command: row.command,
          outputPreview: formatCompletionOutput(output.stdout, output.stderr),
        };
      }),
    };
  }

  markCompletionDelivered(continuationTurnId: TurnId): number {
    return this.deps.repo.markCompletionDelivered(continuationTurnId, Date.now());
  }

  async runCommand(request: BackgroundCommandRequest): Promise<BackgroundCommandResult> {
    if (this.shuttingDown) throw new Error('Background process runtime is shutting down');
    const id = asBackgroundProcessId(crypto.randomUUID());
    const writer = this.output.create(request.sessionId, id);
    const timeoutMs = this.resolveTimeout(request.timeoutMs);
    const frozenRequest = Object.freeze({ ...request, timeoutMs });

    if (request.runInBackground) {
      const row = this.deps.repo.insert({
        id,
        sessionId: request.sessionId,
        originTurnId: request.turnId,
        toolCallId: request.toolCallId,
        command: request.command,
        description: request.description,
        cwd: request.cwd,
        status: 'queued',
        timeoutMs,
        outputRelativePath: writer.location.relativeDirectory,
        createdAt: Date.now(),
      });
      this.queued.set(id, { request: frozenRequest, writer, version: row.version });
      this.enqueuePersistent(id);
      this.emitRow(row);
      return {
        kind: 'processReference',
        backgroundProcessId: id,
        status: this.active.has(id) ? 'running' : 'queued',
        outputPreview: 'Command accepted by the background process queue.',
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
      this.scheduler.release();
      throw abortError();
    }

    let active: ActiveProcess;
    try {
      active = this.startProcess(id, frozenRequest, writer, false, true);
    } catch (error) {
      writer.close();
      this.output.remove(writer.location);
      this.scheduler.release();
      throw error;
    }

    const transfer = Symbol('transfer');
    let winner: CommandRunResult | typeof transfer;
    try {
      winner = await Promise.race([
        active.handle.completion,
        delay(IMMEDIATE_RESULT_WAIT_MS, transfer),
      ]);
    } catch (error) {
      active.detachWaitAbort?.();
      this.active.delete(id);
      writer.close();
      this.output.remove(writer.location);
      this.scheduler.release();
      this.notifyChanged(id);
      throw error;
    }

    if (winner !== transfer) {
      active.detachWaitAbort?.();
      this.active.delete(id);
      writer.close();
      this.output.remove(writer.location);
      this.scheduler.release();
      this.notifyChanged(id);
      return {
        kind: 'commandResult',
        result: winner,
        durationMs: Date.now() - active.startedAt,
      };
    }

    // 结果所有权已转交后台：从此不再响应原 Turn 的取消信号。
    active.detachWaitAbort?.();
    active.detachWaitAbort = undefined;
    const row = this.deps.repo.insert({
      id,
      sessionId: request.sessionId,
      originTurnId: request.turnId,
      toolCallId: request.toolCallId,
      command: request.command,
      description: request.description,
      cwd: request.cwd,
      status: 'running',
      timeoutMs,
      outputRelativePath: writer.location.relativeDirectory,
      createdAt: active.startedAt,
      startedAt: active.startedAt,
      stdoutBytes: writer.stdoutBytes,
      stderrBytes: writer.stderrBytes,
      outputTruncated: writer.truncated,
    });
    active.persisted = true;
    active.version = row.version;
    this.emitRow(row);
    void this.finishActive(id, active);
    return {
      kind: 'processReference',
      backgroundProcessId: id,
      status: 'running',
      outputPreview:
        `Command is still running; ${writer.stdoutBytes + writer.stderrBytes} output bytes captured.`,
    };
  }

  list(
    sessionId: SessionId,
    options: { status?: BackgroundProcessStatus; limit?: number } = {},
  ): BackgroundProcessSummary[] {
    return this.deps.repo.listForSession(sessionId, options).map(toSummary);
  }

  async readOutput(
    sessionId: SessionId,
    id: BackgroundProcessId,
    options: BackgroundProcessOutputOptions = {},
  ): Promise<BackgroundProcessOutput> {
    let row = this.requireOwned(sessionId, id);
    const cursor = decodeOutputCursor(options.cursor);
    let chunk = this.output.read(this.locationFor(row), cursor);

    const waitMs = Math.min(Math.max(options.waitMs ?? 0, 0), 30_000);
    if (waitMs > 0 && !chunk.stdout && !chunk.stderr && isLive(row.status)) {
      await this.waitForChange(id, waitMs);
      row = this.requireOwned(sessionId, id);
      chunk = this.output.read(this.locationFor(row), cursor);
    }

    return {
      process: toSummary(row),
      stdout: chunk.stdout,
      stderr: chunk.stderr,
      nextCursor: encodeOutputCursor({
        stdoutOffset: chunk.stdoutOffset,
        stderrOffset: chunk.stderrOffset,
      }),
      hasMore: chunk.hasMore,
    };
  }

  stop(sessionId: SessionId, id: BackgroundProcessId): BackgroundProcessSummary {
    const row = this.requireOwned(sessionId, id);
    if (!isLive(row.status)) return toSummary(row);

    const queued = this.queued.get(id);
    if (queued) {
      this.scheduler.cancel(id, new Error('Background process stopped before start'));
      this.queued.delete(id);
      queued.writer.close();
      const terminal = this.deps.repo.finish(id, row.version, {
        status: 'stopped',
        completedAt: Date.now(),
        terminationReason: 'Stopped by user',
        stdoutBytes: queued.writer.stdoutBytes,
        stderrBytes: queued.writer.stderrBytes,
        outputTruncated: queued.writer.truncated,
      });
      if (!terminal) throw new Error('Background process state changed before stop');
      this.emitRow(terminal);
      this.notifyChanged(id);
      return toSummary(terminal);
    }

    const active = this.active.get(id);
    if (!active) {
      throw new Error('Background process is no longer attached to this application process');
    }
    active.terminalIntent = 'stopped';
    active.handle.stop();
    return toSummary(row);
  }

  /**
   * Session 永久删除前同步关闭日志句柄并停止进程树，避免 Windows 因文件仍打开而
   * 无法删除 Session 目录。数据库行随后由 Session 外键级联删除。
   */
  discardSession(sessionId: SessionId): void {
    for (const [id, queued] of this.queued) {
      if (queued.request.sessionId !== sessionId) continue;
      this.scheduler.cancel(id, new Error('Session deleted'));
      this.queued.delete(id);
      queued.writer.close();
      this.notifyChanged(id);
    }
    for (const [id, active] of this.active) {
      if (active.request.sessionId !== sessionId) continue;
      active.terminalIntent = 'interrupted';
      active.writer.close();
      active.handle.stop();
      this.notifyChanged(id);
    }
  }

  async shutdown(): Promise<void> {
    this.shuttingDown = true;
    this.completionListener = undefined;
    for (const [id, queued] of this.queued) {
      const row = this.deps.repo.findById(id);
      this.scheduler.cancel(id, new Error('Application is shutting down'));
      queued.writer.close();
      if (row) {
        const terminal = this.deps.repo.finish(id, row.version, {
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
    this.scheduler.enqueue(queued.request.sessionId, {
      id,
      start: () => {
        const current = this.queued.get(id);
        if (!current) {
          this.scheduler.release();
          return;
        }
        this.queued.delete(id);
        const startedAt = Date.now();
        const row = this.deps.repo.transitionToRunning(id, current.version, startedAt);
        if (!row) {
          current.writer.close();
          this.scheduler.release();
          return;
        }
        try {
          const active = this.startProcess(id, current.request, current.writer, true, false);
          active.version = row.version;
          this.emitRow(row);
          void this.finishActive(id, active);
        } catch (error) {
          current.writer.close();
          this.scheduler.release();
          const failed = this.deps.repo.finish(id, row.version, {
            status: 'failed',
            completedAt: Date.now(),
            terminationReason: error instanceof Error ? error.message : String(error),
            stdoutBytes: current.writer.stdoutBytes,
            stderrBytes: current.writer.stderrBytes,
            outputTruncated: current.writer.truncated,
          });
          if (failed) {
            this.emitRow(failed);
            this.completionListener?.(failed.session_id);
          }
          this.notifyChanged(id);
        }
      },
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
        if (this.scheduler.cancel(id, abortError())) reject(abortError());
      };
      signal.addEventListener('abort', onAbort, { once: true });
      this.scheduler.enqueue(sessionId, {
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
    this.scheduler.release();

    if (!active.persisted || active.version === undefined) {
      this.notifyChanged(id);
      return;
    }
    const status = terminalStatus(active, result);
    const row = this.deps.repo.finish(id, active.version, {
      status,
      completedAt: Date.now(),
      exitCode: result.exitCode,
      terminationReason: terminalReason(active, result),
      stdoutBytes: active.writer.stdoutBytes,
      stderrBytes: active.writer.stderrBytes,
      outputTruncated: active.writer.truncated,
    });
    if (row) {
      this.emitRow(row);
      if (isNotifiable(row.status)) {
        this.completionListener?.(row.session_id);
      }
    }
    this.notifyChanged(id);
  }

  private resolveTimeout(requested?: number): number {
    const max = this.deps.settings().maxRuntimeHours * 60 * 60 * 1_000;
    return Math.min(Math.max(requested ?? max, 1_000), max);
  }

  private requireOwned(sessionId: SessionId, id: BackgroundProcessId): BackgroundProcessRow {
    const row = this.deps.repo.findById(id);
    if (!row || row.session_id !== sessionId) {
      throw new Error('Background process not found in the current Session');
    }
    return row;
  }

  private locationFor(row: BackgroundProcessRow) {
    return this.deps.outputPath(row.session_id, row.id);
  }

  private emitRow(row: BackgroundProcessRow): void {
    this.deps.emit?.({
      type: 'background_process_changed',
      sessionId: row.session_id,
      backgroundProcessId: row.id,
      ...(row.origin_turn_id ? { originTurnId: row.origin_turn_id } : {}),
      ...(row.tool_call_id ? { toolCallId: row.tool_call_id } : {}),
      status: row.status,
      at: row.completed_at ?? row.started_at ?? row.created_at,
      ...(row.exit_code !== null ? { exitCode: row.exit_code } : {}),
      ...(row.termination_reason
        ? { terminationReason: row.termination_reason }
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

function toSummary(row: BackgroundProcessRow): BackgroundProcessSummary {
  const end = row.completed_at ?? Date.now();
  return {
    id: row.id,
    sessionId: row.session_id,
    ...(row.origin_turn_id ? { originTurnId: row.origin_turn_id } : {}),
    ...(row.tool_call_id ? { toolCallId: row.tool_call_id } : {}),
    command: row.command,
    ...(row.description ? { description: row.description } : {}),
    cwd: row.cwd,
    status: row.status,
    createdAt: row.created_at,
    ...(row.started_at !== null ? { startedAt: row.started_at } : {}),
    ...(row.completed_at !== null ? { completedAt: row.completed_at } : {}),
    durationMs: Math.max(0, end - (row.started_at ?? row.created_at)),
    ...(row.exit_code !== null ? { exitCode: row.exit_code } : {}),
    ...(row.termination_reason
      ? { terminationReason: row.termination_reason }
      : {}),
    stdoutBytes: row.stdout_bytes,
    stderrBytes: row.stderr_bytes,
    outputTruncated: row.output_truncated === 1,
  };
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

function abortError(): Error {
  return Object.assign(new Error('Command cancelled before start'), { name: 'AbortError' });
}
