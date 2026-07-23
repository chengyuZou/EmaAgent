// 这里负责把模型产生的工具调用依次完成权限检查、执行、记日志和结果回传。
/**
 * TurnToolExecutor 负责带并发控制的流式工具执行。
 *
 * 执行方式参考 Claude Code 的 StreamingToolExecutor：
 *  - 每次收到 tool_use_complete 就立即调用 addTool()，无需等待模型流结束，
 *    权限检查和工具执行可以提前开始。
 *  - 标记为并发安全的工具可以彼此并行，但仍需等待正在执行的非并发工具结束。
 *  - 非并发工具独占执行，必须同时等待串行栅栏和此前排队的并发安全工具。
 *  - 权限弹窗、进度和结果通过 pushEv() 入队，再由 signal() 唤醒 Engine，
 *    使事件能穿插在模型流分块之间发送。
 */

import { asToolCallId } from '@ema-agent/ids';
import type { SessionId, ToolCallId, TurnId } from '@ema-agent/ids';
import type { ToolResultBlock } from '@ema-agent/session';
import type {
  ToolExecutionJournalPort,
  ToolExecutionStatus,
} from '@ema-agent/tools';
import { splitToolResult, ToolInputError } from '@ema-agent/tools';
import type {
  ToolExecutionContext,
  ICommandRunner,
  PreparedToolCall,
  ToolResultStore,
} from '@ema-agent/tools';
import type { ToolManifestSnapshot } from '@ema-agent/tools';
import type { PermissionEngine, PermissionContext } from '@ema-agent/permission';
import type { HookBus, ToolFailurePhase } from '@ema-agent/hooks';
import type { AgentDeps } from './types.js';
import type { AgentToolEvent } from './events.js';

// ── 单个工具的内部状态 ────────────────────────────────────────────────────────

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

// ── 公开配置 ──────────────────────────────────────────────────────────────────

export interface TurnToolExecutorOpts {
  sessionId:   SessionId;
  turnId:      TurnId;
  /** 同步策略检查；不在当前 Agent capability 集合中的工具直接拒绝。 */
  allows:      (name: string) => boolean;
  /** 模型看见的同一份不可变工具清单；旧测试适配器可以暂时省略。 */
  toolManifest?: ToolManifestSnapshot;
  tools:       AgentDeps['tools'];
  permission:  PermissionEngine;
  permCtx:     PermissionContext;
  hooks:       HookBus;
  toolCtx:     ToolExecutionContext;
  buildAsk?:   AgentDeps['buildAsk'];
  runner?:     ICommandRunner;
  /**
   * 把事件写入 Engine 的待发送队列，例如 tool_result 或 permission_required。
   * 实现方还应调用 signal() 唤醒排空循环。
   */
  pushEv:      (ev: AgentToolEvent) => void;
  /**
   * 唤醒 Engine 的排空循环。track.done 变为 true 时会独立于 pushEv 调用，
   * 确保没有新事件时循环也能重新检查 allDone()。
   */
  signal:      () => void;
  /**
   * Session 范围的工具结果存储。存在时，大结果会落盘，tool_result 只保存预览和文件引用。
   * 测试与非 Agent 调用方可省略，此时结果完整内联。
   */
  toolResultStore?: ToolResultStore;
  /** 工具执行审计 Facade；生产环境必须注入，测试可省略。 */
  toolExecutionJournal?: ToolExecutionJournalPort;
}

// ── Turn 工具执行器 ───────────────────────────────────────────────────────────

export class TurnToolExecutor {
  private tracked:    TrackedTool[] = [];
  /**
   * 串行栅栏会在全部非并发工具结束后完成。
   * 并发安全工具启动前也要等待该栅栏，避免与尚未完成的独占工具竞争；
   * 新的非并发工具入队时会推进栅栏。
   */
  private serialTail: Promise<void> = Promise.resolve();
  /**
   * 每个工具拥有按 callId 索引的 AbortController。
   * Turn 取消信号会级联触发全部控制器，abortTool(callId) 只取消指定工具。
   */
  private readonly toolAborts = new Map<string, AbortController>();
  private stoppingReason?: string;

  constructor(private readonly opts: TurnToolExecutorOpts) {}

  /** 取消单个执行中的工具，不中止父 Turn；找不到时返回 false。 */
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

  /** 在两次 LLM 迭代之间重置状态。 */
  reset(): void {
    this.tracked    = [];
    this.serialTail = Promise.resolve();
    this.stoppingReason = undefined;
  }

  /**
   * 注册工具调用并立即开始执行。
   * 策略拒绝或未知工具只生成错误结果，不会真正执行。
   * 模型仍在流式输出时也可以调用。
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
    } else if (!this.opts.toolManifest && !tools.has(name)) {
      preflightFailure = {
        phase: 'validation',
        code: 'tool/not_found',
        message: `Unknown tool: "${name}"`,
        retryable: true,
      };
    } else {
      try {
        prepared = tools.prepare(name, args, this.opts.toolManifest);
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
        turnId: this.opts.turnId,
        agentRunId: this.opts.toolCtx.agentRunId,
        toolName: prepared?.id ?? name,
        input: prepared?.input ?? args,
      });
      track.journalStatus = 'prepared';
    }

    // 快照当前工具之前已经加入的 Promise，供非并发工具等待正在执行的并发安全工具。
    const priorPromises = this.tracked
      .map(t => t.promise)
      .filter((p): p is Promise<void> => p !== undefined);

    this.tracked.push(track);

    if (isConcurrencySafe) {
      // 串行栅栏清空后立即执行；多个并发安全工具可以彼此并行。
      track.promise = this.serialTail
        .then(() => this.executeOne(track))
      .catch(() => { /* executeOne 已在内部处理错误 */ });
    } else {
      // 非并发工具必须同时等待串行栅栏和此前全部并发安全工具。
      const fence = Promise.allSettled([this.serialTail, ...priorPromises]);
      const p     = fence.then(() => this.executeOne(track)).catch(() => {});
      // 推进栅栏，让后续非并发工具等待当前调用。
      this.serialTail = p;
      track.promise   = p;
    }
  }

  /** 全部已注册工具都产生结果后返回 true。 */
  allDone(): boolean {
    return this.tracked.every(t => t.done);
  }

  /** 只要任一询问用户的工具尚未收到回答，就保持 waiting_user 状态。 */
  hasWaitingUserTool(): boolean {
    return this.tracked.some(track => track.prepared?.requiresUserInteraction === true && !track.done);
  }

  /** 按 blockIndex 返回工具结果，应在 allDone() 后调用。 */
  getResults(): ToolResultBlock[] {
    const sorted = [...this.tracked]
      .filter(track => track.result !== undefined)
      .sort((left, right) => left.blockIndex - right.blockIndex);
    const store = this.opts.toolResultStore;
    if (!store) return sorted.map(track => track.result!);

    const contents = store.enforceAggregateBudget(
      sorted.flatMap(track => (
        track.prepared
        && track.result
        && typeof track.result.content === 'string'
      )
        ? [{
            callId: track.id,
            toolName: track.name,
            content: track.result.content,
            maxResultBytes: track.prepared.maxResultBytes,
          }]
        : []),
    );
    return sorted.map((track) => {
      const result = track.result!;
      const content = contents.get(track.id);
      return content === undefined || content === result.content
        ? result
        : { ...result, content };
    });
  }

  // ── 内部执行流程 ──────────────────────────────────────────────────────────

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

    // ── 单工具 AbortController ────────────────────────────────────────────────
    // Turn 信号会级联取消全部工具，abortTool(callId) 只触发当前控制器并保留 Turn。
    const perToolCtrl    = new AbortController();
    const onTurnAbort    = (): void => perToolCtrl.abort();
    toolCtx.signal.addEventListener('abort', onTurnAbort, { once: true });
    this.toolAborts.set(id, perToolCtrl);

    try {
      // ── 工具观察 Hook ─────────────────────────────────────────────────────
      // 工具生命周期 Hook 只负责 UI 与审计观察。PermissionEngine 是执行门禁，
      // Sandbox Runner 才是隔离边界。
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

      const perToolCtx: ToolExecutionContext = {
        ...toolCtx,
        toolCallId: id,
        signal: perToolCtrl.signal,
      };

      let validation;
      try {
        // 生产装配始终使用 ToolRegistry；旧测试和最小可信适配器在迁移期可省略
        // 业务校验方法，但不能绕过 Registry 的 Schema Prepare 与执行身份检查。
        validation = typeof tools.validate === 'function'
          ? await tools.validate(prepared, perToolCtx)
          : { valid: true as const };
      } catch (error) {
        await this.completeFailure(track, {
          phase: 'validation',
          code: 'tool/validation_error',
          message: errorMessage(error),
          retryable: true,
        }, perToolCtrl.signal);
        return;
      }
      if (!validation.valid) {
        await this.completeFailure(track, {
          phase: 'validation',
          code: validation.code ?? 'tool/invalid_input',
          message: validation.message,
          retryable: validation.retryable ?? true,
        }, perToolCtrl.signal);
        return;
      }

      // ── 权限门禁 ──────────────────────────────────────────────────────────
      // 生产环境中，buildAsk 通过 pushEv 把 permission_required 写入 Engine 队列，
      // 让 SSE 立即送达；测试和最小宿主省略时使用 Engine 级 config.ask。
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
          { id: prepared.id, name, description: prepared.summary },
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

      // ── 执行工具 ──────────────────────────────────────────────────────────
      // 工具接收单调用信号，因此 abortTool() 只取消当前调用；
      // Turn 级信号会级联触发，确保整个 Turn 中止时两者都生效。
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

      // 工具中途被单独取消而 Turn 仍存活时，在部分输出后追加取消说明。
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
      // 用户只取消了当前工具；从模型视角这是可观察结果，不是 LLM 错误。
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

      const serialized = serializeToolOutput(output);
      const { toolResultStore } = this.opts;
      let content = serialized;
      if (toolResultStore) {
        const norm = toolResultStore.normalize(
          id,
          name,
          serialized,
          prepared.maxResultBytes,
        );
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

      // 即使 Hook 或门禁抛出意外错误，也必须标记完成并唤醒排空循环，避免死锁。
      if (!track.done) {
        if (!track.result) {
          const msg = 'Tool execution failed unexpectedly';
          track.result = { type: 'tool_result', toolUseId: id, content: msg, isError: true, durationMs: Date.now() - track.startMs, errorCode: 'tool/internal_error' };
          this.emit(track, { type: 'tool_result', sessionId: this.opts.sessionId, callId: id, name, error: { code: 'tool/internal_error', message: msg }, durationMs: Date.now() - track.startMs });
        }
      }
      track.done = true;
      runner?.cleanup();
      // done 写入后再次唤醒排空循环，使其重新检查 allDone()。
      // pushEv 只在结果事件入队时唤醒，而后续 Hook 可能延迟 done 的写入。
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

  private emit(track: TrackedTool, event: AgentToolEvent): void {
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

function serializeToolOutput(output: unknown): string {
  if (typeof output === 'string') return output;
  const serialized = JSON.stringify(output, null, 2);
  return serialized ?? String(output);
}

// ── 辅助函数 ──────────────────────────────────────────────────────────────────

/**
 * 在工具部分输出后追加取消说明。
 * Bash 类结果包含 stdout 字符串时直接追加到 stdout，使模型仍能看到取消前的输出；
 * 其他结果先序列化，再把说明作为末尾一行。
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
