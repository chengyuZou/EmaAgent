// 这里负责把模型产生的工具调用依次完成权限检查、执行、记日志和结果回传。
/**
 * TurnToolExecutor — streaming tool execution with concurrency control.
 *
 * Mirrors Claude Code's StreamingToolExecutor design:
 *  - addTool() is called immediately on each tool_use_complete event, starting
 *    permission check + execution without waiting for the full LLM stream to end.
 *  - Concurrent-safe tools (PreparedToolCall.isConcurrencySafe === true) run in parallel with
 *    each other, but still wait for any in-flight non-concurrent tool to finish.
 *  - Non-concurrent tools run exclusively: they wait for the serial fence AND all
 *    currently-queued concurrent-safe tools.
 *  - Events (permission dialogs, progress, results) are pushed via pushEv() and
 *    signalled via signal() so the engine can yield them between LLM stream chunks.
 */

import { asToolCallId } from '@ema-agent/contracts';
import type {
  EmaStreamEvent,
  ToolResultBlock,
  SessionId,
  ToolCallId,
  ToolExecutionStatus,
  TurnId,
} from '@ema-agent/contracts';
import { splitToolResult, ToolInputError } from '@ema-agent/tools';
import type { ToolExecutionContext, ICommandRunner, PreparedToolCall } from '@ema-agent/tools';
import type { PermissionEngine, PermissionContext } from '@ema-agent/permission';
import type { HookBus, ToolFailurePhase } from '@ema-agent/hook';
import type { AgentToolResultStore } from '@ema-agent/agent-context';
import type { AgentDeps, IToolExecutionJournal } from './types.js';

/** 会暂停当前工具执行、等待用户从界面回答的内置工具。 */
const USER_INPUT_TOOL_NAMES: ReadonlySet<string> = new Set([
  'AskUser',
  'AskText',
  'AskChoice',
  'AskConfirm',
]);

// ── Internal per-tool state ───────────────────────────────────────────────────

interface TrackedTool {
  blockIndex:        number;
  id:                ToolCallId;
  name:              string;
  args:              unknown;
  prepared?:         PreparedToolCall;
  isConcurrencySafe: boolean;
  startMs:           number;
  done:              boolean;
  result?:           ToolResultBlock;
  promise?:          Promise<void>;
  preflightFailure?: ToolFailure;
  journalStatus?:    ToolExecutionStatus;
  suppressEvents?:   boolean;
}

interface ToolFailure {
  phase:     ToolFailurePhase;
  code:      string;
  message:   string;
  retryable: boolean;
}

// ── Public options ────────────────────────────────────────────────────────────

export interface TurnToolExecutorOpts {
  sessionId:   SessionId;
  turnId:      TurnId;
  /** 子 Agent 共享父 Turn 的数据库 ownership；主 Agent 省略时等于 turnId。 */
  journalTurnId?: TurnId;
  /** 同步策略检查；不在当前 Agent capability 集合中的工具直接拒绝。 */
  allows:      (name: string) => boolean;
  tools:       AgentDeps['tools'];
  permission:  PermissionEngine;
  permCtx:     PermissionContext;
  hooks:       HookBus;
  toolCtx:     ToolExecutionContext;
  buildAsk?:   AgentDeps['buildAsk'];
  runner?:     ICommandRunner;
  /**
   * Push an event into the engine's pending queue (e.g. tool_result, permission_required).
   * Implementations should also call signal() so the drain loop wakes up.
   */
  pushEv:      (ev: EmaStreamEvent) => void;
  /**
   * Wake up the engine's drain loop. Called independently from pushEv when
   * track.done flips to true (so the loop can check allDone() even without a new event).
   */
  signal:      () => void;
  /**
   * Per-session tool-result store. When present, large outputs are offloaded to
   * disk and the tool_result block receives a preview + file reference instead.
   * Absent in tests and non-agent callers — falls back to full inline content.
   */
  toolResultStore?: AgentToolResultStore;
  /** 工具执行审计 Facade；生产环境必须注入，测试可省略。 */
  toolExecutionJournal?: IToolExecutionJournal;
}

// ── TurnToolExecutor ──────────────────────────────────────────────────────────

export class TurnToolExecutor {
  private tracked:    TrackedTool[] = [];
  /**
   * Serial fence: resolves once all in-progress non-concurrent tools have finished.
   * Concurrent-safe tools wait on this before starting (so they don't race a
   * non-concurrent tool that's still in progress).
   * Non-concurrent tools update this fence when they're queued.
   */
  private serialTail: Promise<void> = Promise.resolve();
  /**
   * Per-tool AbortControllers keyed by callId.
   * Each controller is cascaded from the turn-level signal so a turn abort fires all of them.
   * abortTool(callId) fires only one without touching the parent turn.
   */
  private readonly toolAborts = new Map<string, AbortController>();
  private stoppingReason?: string;

  constructor(private readonly opts: TurnToolExecutorOpts) {}

  /** Cancel a single in-flight tool without aborting the parent turn. Returns false if not found. */
  abortTool(callId: string): boolean {
    const ctrl = this.toolAborts.get(callId);
    if (!ctrl) return false;
    ctrl.abort();
    return true;
  }

  /** 停止接收新调用并取消本 Turn 尚未结束的全部工具。 */
  abortAll(reason: string): void {
    this.stoppingReason = reason;
    for (const controller of this.toolAborts.values()) controller.abort();
  }

  /** 等待当前已登记的工具全部退出。 */
  async join(): Promise<void> {
    await Promise.allSettled(
      this.tracked
        .map(track => track.promise)
        .filter((promise): promise is Promise<void> => promise !== undefined),
    );
  }

  /** Turn 进入终态前统一取消并等待工具；超时的副作用只能记为结果未知。 */
  async shutdown(reason: string, timeoutMs = 5_000): Promise<void> {
    this.abortAll(reason);
    let timer: ReturnType<typeof setTimeout> | undefined;
    const joined = this.join().then(() => true);
    const timedOut = new Promise<false>((resolve) => {
      timer = setTimeout(() => resolve(false), timeoutMs);
      timer.unref?.();
    });
    const completed = await Promise.race([joined, timedOut]);
    if (timer) clearTimeout(timer);
    if (completed) return;

    for (const track of this.tracked) {
      if (track.done) continue;
      track.suppressEvents = true;
      this.closeJournalAfterShutdown(track, reason);
    }
  }

  /** Reset between LLM iterations. */
  reset(): void {
    this.tracked    = [];
    this.serialTail = Promise.resolve();
    this.stoppingReason = undefined;
  }

  /**
   * Register a tool call and start executing it immediately.
   * Policy-denied and unknown tools get a synthetic error result without executing.
   * May be called while the LLM stream is still in progress.
   */
  addTool(blockIndex: number, id: string, name: string, args: unknown): void {
    const { allows, tools } = this.opts;
    const callId = asToolCallId(id);
    let preflightFailure: ToolFailure | undefined;
    let isConcurrencySafe = true;
    let prepared: PreparedToolCall | undefined;

    if (!allows(name)) {
      preflightFailure = {
        phase: 'policy',
        code: 'policy/denied',
        message: `Tool "${name}" is not available in this mode`,
        retryable: false,
      };
    } else if (!tools.has(name)) {
      preflightFailure = {
        phase: 'validation',
        code: 'tool/not_found',
        message: `Unknown tool: "${name}"`,
        retryable: true,
      };
    } else {
      try {
        prepared = tools.prepare(name, args);
        isConcurrencySafe = prepared.isConcurrencySafe;
      } catch (err) {
        preflightFailure = classifyPreparationFailure(err);
      }
    }

    // 所有模型工具意图都进入同一异步状态机。即使预检失败，也必须先发出
    // beforeToolUse，再以同一个 ToolCallId 发出 onToolFailure。
    const track: TrackedTool = {
      blockIndex,
      id: callId,
      name,
      args,
      prepared,
      isConcurrencySafe,
      startMs: Date.now(),
      done: false,
      preflightFailure,
    };

    // 任何权限检查或副作用之前，先持久化规范化后的工具意图。日志写入失败时
    // addTool 直接抛错，让 Turn fail-closed，绝不继续执行工具。
    if (this.opts.toolExecutionJournal) {
      this.opts.toolExecutionJournal.prepare({
        callId,
        sessionId: this.opts.sessionId,
        turnId: this.opts.journalTurnId ?? this.opts.turnId,
        toolName: prepared?.id ?? name,
        input: prepared?.input ?? args,
      });
      track.journalStatus = 'prepared';
    }

    // Snapshot the promises of all tools added before this one.
    // Used by non-concurrent tools to wait for currently-running concurrent-safe ones.
    const priorPromises = this.tracked
      .map(t => t.promise)
      .filter((p): p is Promise<void> => p !== undefined);

    this.tracked.push(track);

    if (isConcurrencySafe) {
      // Run as soon as the serial fence clears (i.e. no non-concurrent tool is active).
      // Multiple concurrent-safe tools run in parallel with each other.
      track.promise = this.serialTail
        .then(() => this.executeOne(track))
        .catch(() => { /* executeOne handles errors internally */ });
    } else {
      // Non-concurrent: wait for the serial fence AND every prior concurrent-safe tool.
      const fence = Promise.allSettled([this.serialTail, ...priorPromises]);
      const p     = fence.then(() => this.executeOne(track)).catch(() => {});
      // Advance the fence so future non-concurrent tools wait for us.
      this.serialTail = p;
      track.promise   = p;
    }
  }

  /** Returns true once every registered tool has produced a result. */
  allDone(): boolean {
    return this.tracked.every(t => t.done);
  }

  /** 只要任一询问用户的工具尚未收到回答，就保持 waiting_user 状态。 */
  hasWaitingUserTool(): boolean {
    return this.tracked.some(t => USER_INPUT_TOOL_NAMES.has(t.name) && !t.done);
  }

  /** Returns tool results sorted by blockIndex. Call after allDone(). */
  getResults(): ToolResultBlock[] {
    return [...this.tracked]
      .sort((a, b) => a.blockIndex - b.blockIndex)
      .map(t => t.result!)
      .filter(Boolean);
  }

  // ── Private execution ─────────────────────────────────────────────────────

  private async executeOne(track: TrackedTool): Promise<void> {
    const {
      sessionId, turnId, permission, permCtx, hooks, toolCtx, tools, buildAsk, runner, signal,
    } = this.opts;
    const { id, name, args, prepared } = track;

    if (this.stoppingReason) {
      this.completeCancellation(track, this.stoppingReason);
      track.done = true;
      signal();
      return;
    }

    // ── Per-tool AbortController ──────────────────────────────────────────────
    // Cascades from the turn signal so turn-level abort fires all tool aborts.
    // abortTool(callId) fires only this controller, leaving the turn running.
    const perToolCtrl    = new AbortController();
    const onTurnAbort    = (): void => perToolCtrl.abort();
    toolCtx.signal.addEventListener('abort', onTurnAbort, { once: true });
    this.toolAborts.set(id, perToolCtrl);

    try {
      // ── Tool observer hook ────────────────────────────────────────────────
      // Tool lifecycle hooks are UI/audit observers only. PermissionEngine is
      // the execution gate, and the sandbox runner is the isolation boundary.
      await hooks.trigger('beforeToolUse', {
        turnId, sessionId,
        payload: { callId: id, name, args: prepared?.input ?? args },
        signal: perToolCtrl.signal,
        emit: event => this.emit(track, event),
      });

      // 工具入队后，SkillCall 或未来运行模式可能已经收窄能力。这里在权限审批和
      // 副作用之前重新检查，封住同一轮多个工具调用的策略变更竞态。
      if (!this.opts.allows(name)) {
        await this.completeFailure(track, {
          phase: 'policy',
          code: 'policy/denied',
          message: `Tool "${name}" is no longer available in the current capability scope`,
          retryable: false,
        }, perToolCtrl.signal);
        return;
      }

      if (track.preflightFailure) {
        await this.completeFailure(track, track.preflightFailure, perToolCtrl.signal);
        return;
      }

      if (!prepared) {
        await this.completeFailure(track, {
          phase: 'validation',
          code: 'tool/preparation_missing',
          message: `Tool "${name}" has no prepared input`,
          retryable: false,
        }, perToolCtrl.signal);
        return;
      }

      // ── Permission gate ───────────────────────────────────────────────────
      // In production, buildAsk routes permission_required events through pushEv
      // into the engine's pending queue so the SSE stream delivers them immediately.
      // Tests/minimal hosts that omit buildAsk fall back to the engine-level config.ask.
      const permCtxWithAsk: PermissionContext = buildAsk
        ? { ...permCtx, sessionId, turnId, toolCallId: id, ask: buildAsk({
            sessionId,
            turnId,
            toolCallId: id,
            emit: event => this.emit(track, event),
          }) }
        : { ...permCtx, sessionId, turnId, toolCallId: id };

      let outcome;
      try {
        // 权限审批和工具执行共享同一个深冻结 PreparedToolCall 输入。
        outcome = await permission.gate(
          { id: prepared.id, name },
          prepared.input,
          prepared.permissionMeta,
          permCtxWithAsk,
        );
      } catch (err) {
        if (isCancelled(perToolCtrl.signal, toolCtx.signal)) {
          this.completeCancellation(track, this.stoppingReason ?? 'user_abort');
          return;
        }
        await this.completeFailure(track, {
          phase: 'permission',
          code: 'permission/error',
          message: errorMessage(err),
          retryable: true,
        }, perToolCtrl.signal);
        return;
      }

      if (!outcome.granted) {
        await this.completeFailure(track, {
          phase: 'permission',
          code: 'permission/denied',
          message: `Permission denied: ${outcome.reason}`,
          retryable: false,
        }, perToolCtrl.signal);
        return;
      }

      this.opts.toolExecutionJournal?.authorize(id);
      if (this.opts.toolExecutionJournal) track.journalStatus = 'authorized';

      // ── Execute ───────────────────────────────────────────────────────────
      // Tools receive the per-tool signal so abortTool() can cancel just this
      // invocation. The turn-level signal is cascaded so both fire on turn abort.
      const perToolCtx: ToolExecutionContext = {
        ...toolCtx,
        toolCallId: id,
        signal: perToolCtrl.signal,
      };
      let output: unknown;
      let presentation: ToolResultBlock['presentation'];
      let isError = false;

      try {
        // running 是副作用边界：只有该状态成功落库后才能真正 dispatch。
        this.opts.toolExecutionJournal?.start(id);
        if (this.opts.toolExecutionJournal) track.journalStatus = 'running';
        const executed = splitToolResult(await tools.execute(prepared, perToolCtx));
        output = executed.modelOutput;
        presentation = executed.presentation;

        // If aborted mid-run but the turn is still alive, annotate the partial output.
        if (perToolCtrl.signal.aborted && !toolCtx.signal.aborted) {
          output = annotateAborted(output);
        }

        try {
          this.opts.toolExecutionJournal?.succeed(id, output);
          if (this.opts.toolExecutionJournal) track.journalStatus = 'succeeded';
        } catch (err) {
          this.tryMarkOutcomeUnknown(track, `工具已返回，但结果日志写入失败：${errorMessage(err)}`);
          await this.completeFailure(track, {
            phase: 'persistence',
            code: 'tool/outcome_unknown',
            message: '工具可能已经产生副作用，但执行结果未能可靠持久化，请勿自动重试',
            retryable: false,
          }, perToolCtrl.signal, true);
          return;
        }

        this.emit(track, {
          type: 'tool_result', sessionId: this.opts.sessionId, callId: id, name, output,
          ...(presentation ? { presentation } : {}),
          durationMs: Date.now() - track.startMs,
        });
        await hooks.trigger('afterToolUse', {
          turnId, sessionId,
          payload: { callId: id, name, output },
          signal: perToolCtrl.signal,
          emit: event => this.emit(track, event),
        });
      } catch (err) {
        // Per-tool abort (user cancelled this tool) — not an error from the LLM's perspective.
        if (perToolCtrl.signal.aborted && !toolCtx.signal.aborted) {
          output  = '[用户中途终止]';
          isError = false;
          this.completeCancellation(track, 'user_abort');
          this.emit(track, { type: 'tool_result', sessionId: this.opts.sessionId, callId: id, name, output, durationMs: Date.now() - track.startMs });
        } else if (toolCtx.signal.aborted) {
          this.completeCancellation(track, 'turn_abort');
          return;
        } else {
          const failure = classifyDispatchFailure(err);
          await this.completeFailure(track, failure, perToolCtrl.signal);
          return;
        }
      }

      const serialized = typeof output === 'string' ? output : JSON.stringify(output, null, 2);
      const { toolResultStore } = this.opts;
      let content = serialized;
      if (toolResultStore) {
        const norm = toolResultStore.maybeNormalize(id, name, serialized);
        if (norm.kind !== 'unchanged') content = norm.blockContent;
      }
      track.result = {
        type: 'tool_result', toolUseId: id, content, isError,
        durationMs: Date.now() - track.startMs,
        errorCode: isError ? 'tool/error' : undefined,
        ...(presentation ? { presentation } : {}),
      };

    } catch (err) {
      if (isCancelled(perToolCtrl.signal, toolCtx.signal)) {
        this.completeCancellation(track, this.stoppingReason ?? 'user_abort');
      } else if (!track.result) {
        await this.completeFailure(track, {
          phase: 'execution',
          code: 'tool/internal_error',
          message: errorMessage(err),
          retryable: false,
        }, perToolCtrl.signal);
      }
    } finally {
      toolCtx.signal.removeEventListener('abort', onTurnAbort);
      this.toolAborts.delete(id);

      // Always mark done and signal the drain loop — even if an unexpected error
      // escaped from hooks or the gate. Prevents the drain loop from deadlocking.
      if (!track.done) {
        if (!track.result) {
          const msg = 'Tool execution failed unexpectedly';
          track.result = { type: 'tool_result', toolUseId: id, content: msg, isError: true, durationMs: Date.now() - track.startMs, errorCode: 'tool/internal_error' };
          this.emit(track, { type: 'tool_result', sessionId: this.opts.sessionId, callId: id, name, error: { code: 'tool/internal_error', message: msg }, durationMs: Date.now() - track.startMs });
        }
      }
      track.done = true;
      runner?.cleanup();
      // Signal the drain loop that allDone() may now be true.
      // (pushEv already signalled for the result event, but hooks run after pushEv,
      // so we need a second signal here to wake the loop after done is set.)
      signal();
    }
  }

  private async completeFailure(
    track: TrackedTool,
    failure: ToolFailure,
    hookSignal: AbortSignal,
    skipJournal = false,
  ): Promise<void> {
    if (!skipJournal) this.failJournal(track, failure.code, failure.message);
    const durationMs = Date.now() - track.startMs;
    track.result = {
      type: 'tool_result',
      toolUseId: track.id,
      content: failure.message,
      isError: true,
      durationMs,
      errorCode: failure.code,
    };
    this.emit(track, {
      type: 'tool_result',
      sessionId: this.opts.sessionId,
      callId: track.id,
      name: track.name,
      error: { code: failure.code, message: failure.message },
      durationMs,
    });
    await this.opts.hooks.trigger('onToolFailure', {
      turnId: this.opts.turnId,
      sessionId: this.opts.sessionId,
      payload: {
        callId: track.id,
        name: track.name,
        phase: failure.phase,
        code: failure.code,
        message: failure.message,
        retryable: failure.retryable,
      },
      signal: hookSignal,
      emit: event => this.emit(track, event),
    });
  }

  private completeCancellation(track: TrackedTool, reason = 'user_abort'): void {
    if (track.journalStatus === 'running') {
      this.tryMarkOutcomeUnknown(track, `运行中的工具被取消，副作用是否完成未知：${reason}`);
    } else if (track.journalStatus === 'prepared' || track.journalStatus === 'authorized') {
      try {
        this.opts.toolExecutionJournal?.cancel(track.id, reason);
        if (this.opts.toolExecutionJournal) track.journalStatus = 'cancelled';
      } catch {
        // 终止路径不能因审计库故障再次阻塞；启动恢复会继续清理非终态记录。
      }
    }
    track.result = {
      type: 'tool_result',
      toolUseId: track.id,
      content: '[用户中途终止]',
      isError: false,
      durationMs: Date.now() - track.startMs,
    };
  }

  private emit(track: TrackedTool, event: EmaStreamEvent): void {
    if (!track.suppressEvents) this.opts.pushEv(event);
  }

  private failJournal(track: TrackedTool, code: string, message: string): void {
    if (!isJournalNonTerminal(track.journalStatus)) return;
    try {
      this.opts.toolExecutionJournal?.fail(track.id, code, message);
      if (this.opts.toolExecutionJournal) track.journalStatus = 'failed';
    } catch {
      // 工具未成功时仍可返回错误；原状态留给启动恢复处理。
    }
  }

  private tryMarkOutcomeUnknown(track: TrackedTool, reason: string): void {
    if (track.journalStatus !== 'running') return;
    try {
      this.opts.toolExecutionJournal?.outcomeUnknown(track.id, reason);
      if (this.opts.toolExecutionJournal) track.journalStatus = 'outcome_unknown';
    } catch {
      // 数据库不可用时保留 running，下一次启动恢复会转换为 outcome_unknown。
    }
  }

  private closeJournalAfterShutdown(track: TrackedTool, reason: string): void {
    if (track.journalStatus === 'running') {
      this.tryMarkOutcomeUnknown(track, `Turn 已终止但工具未在时限内退出：${reason}`);
      return;
    }
    if (track.journalStatus === 'prepared' || track.journalStatus === 'authorized') {
      try {
        this.opts.toolExecutionJournal?.cancel(track.id, reason);
        if (this.opts.toolExecutionJournal) track.journalStatus = 'cancelled';
      } catch {
        // 启动恢复会清理尚未越过副作用边界的记录。
      }
    }
  }
}

// ── Helpers ───────────────────────────────────────────────────────────────────

/**
 * Append an abort notice to a tool's partial output.
 * For bash-like results (objects with a `stdout` string field), the notice is
 * appended to stdout so the LLM sees what was printed before cancellation.
 * All other types are serialised and the notice appended as a trailing line.
 */
function annotateAborted(output: unknown): unknown {
  const notice = '\n[用户中途终止]';
  if (output && typeof output === 'object' && typeof (output as Record<string, unknown>)['stdout'] === 'string') {
    const r = output as Record<string, unknown>;
    return { ...r, stdout: (r['stdout'] as string) + notice };
  }
  if (typeof output === 'string') return output + notice;
  return String(JSON.stringify(output) ?? '') + notice;
}

function classifyPreparationFailure(err: unknown): ToolFailure {
  if (err instanceof ToolInputError) {
    return {
      phase: 'validation',
      code: 'tool/validation_failed',
      message: err.message,
      retryable: true,
    };
  }
  return {
    phase: 'validation',
    code: 'tool/preparation_failed',
    message: errorMessage(err),
    retryable: false,
  };
}

function classifyDispatchFailure(err: unknown): ToolFailure {
  return {
    phase: 'execution',
    code: 'tool/error',
    message: errorMessage(err),
    retryable: false,
  };
}

function isCancelled(perToolSignal: AbortSignal, turnSignal: AbortSignal): boolean {
  return perToolSignal.aborted || turnSignal.aborted;
}

function isJournalNonTerminal(status: ToolExecutionStatus | undefined): boolean {
  return status === 'prepared' || status === 'authorized' || status === 'running';
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
