// 这里创建和管理子 Agent，并处理它们的共享临时数据、取消和事件上报。

import { randomUUID } from 'node:crypto';
import type { LlmMessage, SessionId, TurnId, EmaStreamEvent, ToolError } from '@ema-agent/contracts';
import type { ISubagentSpawner, SubagentSpawnOpts, ToolExecutionContext } from '@ema-agent/tools';
import { clearTodos } from '@ema-agent/tool-builtin';
import type { AgentDeps } from './types.js';
import { AgentPolicy } from './policy.js';
import { TurnToolExecutor } from './tool-executor.js';
import { agentLoop, type ExecutorFactory } from './loop.js';

// ── SubagentSpawner ───────────────────────────────────────────────────────────
//
// Implements ISubagentSpawner. Responsible for ALL sub-agent dashboard events:
//   subagent_started / subagent_progress / subagent_stream / subagent_completed
//   subagent_failed / subagent_aborted
//
// The subagent tool only pre-allocates a subagentId and calls spawn().
// Everything else — model resolution, timing, usage, event emission — lives here.
//
// AbortController model:
//   Each spawn() creates a child AbortController linked to the parent signal.
//   Parent abort → cascades to all active sub-agents automatically.
//   abortSubagent(id) → cancels one sub-agent without touching the parent turn.
//
// taskStore integration:
//   claim() before the loop; complete/fail/cancel on exit.
//   turnId is null for sub-agents (no DB turn record); parentId = parentTurnId.

const RESULT_EXCERPT_MAX = 500;   // chars for tool_result excerpt in detail stream
const OUTPUT_EXCERPT_MAX = 200;   // chars for subagent_completed.outputExcerpt

export class SubagentSpawner implements ISubagentSpawner {
  // Keyed by subagentId — used by abortSubagent().
  private readonly activeSubagents   = new Map<string, AbortController>();
  // Background spawns: subagentId → result Promise (for awaitBackground).
  private readonly backgroundSpawns  = new Map<string, Promise<{ output: string; usage: { inputTokens: number; outputTokens: number } }>>();
  // Mailbox queues: subagentId → pending coordinator messages.
  private readonly pendingMessages   = new Map<string, string[]>();
  private stoppingReason: string | undefined;

  constructor(
    private readonly deps:                  AgentDeps,
    private readonly parentSessionId:       string,
    private readonly parentTurnId:          string,   // the main agent's turn — NOT the sub-agent's id
    private readonly parentProviderId:      string,
    private readonly parentModel:           string,
    private readonly parentMessages:        LlmMessage[],
    private readonly scratchpadDir?:        string,
    private readonly getScratchpadContext?: () => string | undefined,
    private readonly parentEmit?:           (ev: EmaStreamEvent) => void,
  ) {}

  // ── Background spawn ──────────────────────────────────────────────────────

  spawnBackground(prompt: string, opts: SubagentSpawnOpts, signal: AbortSignal): string {
    const subagentId = opts.subagentId ?? randomUUID();
    const optsWithId: SubagentSpawnOpts = { ...opts, subagentId };
    // Initialise an empty mailbox queue so queueMessage() works immediately.
    this.pendingMessages.set(subagentId, []);
    const p = this.spawn(prompt, optsWithId, signal).finally(() => {
      this.pendingMessages.delete(subagentId);
    });
    // Suppress unhandled rejection: if awaitBackground() is never called and the
    // sub-agent fails, the stored Promise would produce an UnhandledPromiseRejection
    // when GC drops the Map entry. The error is already surfaced via subagent_failed
    // SSE event; awaitBackground()'s own `await p` still re-throws correctly.
    p.catch(() => {});
    this.backgroundSpawns.set(subagentId, p);
    return subagentId;
  }

  async awaitBackground(
    subagentId: string,
  ): Promise<{ output: string; usage: { inputTokens: number; outputTokens: number } } | null> {
    const p = this.backgroundSpawns.get(subagentId);
    if (!p) return null;
    try {
      return await p;
    } finally {
      this.backgroundSpawns.delete(subagentId);
    }
  }

  // ── Mailbox ───────────────────────────────────────────────────────────────

  queueMessage(subagentId: string, message: string): boolean {
    const queue = this.pendingMessages.get(subagentId);
    if (!queue) return false;   // sub-agent not active or already finished
    queue.push(message);
    return true;
  }

  // ── Per-subagent cancellation ─────────────────────────────────────────────

  abortSubagent(subagentId: string): void {
    this.activeSubagents.get(subagentId)?.abort();
  }

  /** 父 Turn 收口时取消并等待所有未显式 await 的后台子 Agent。 */
  async shutdown(reason: string): Promise<void> {
    this.stoppingReason = reason;
    for (const controller of this.activeSubagents.values()) {
      controller.abort(new Error(reason));
    }
    await Promise.allSettled(this.backgroundSpawns.values());
    this.backgroundSpawns.clear();
    this.pendingMessages.clear();
  }

  // ── Spawn ─────────────────────────────────────────────────────────────────

  async spawn(
    prompt:  string,
    opts:    SubagentSpawnOpts,
    signal:  AbortSignal,
  ): Promise<{ output: string; usage: { inputTokens: number; outputTokens: number } }> {
    const { tools, llm, permission, hooks } = this.deps;
    const policy        = new AgentPolicy(tools.list());
    const subagentId    = opts.subagentId ?? randomUUID();
    const sessionId     = this.parentSessionId as SessionId;
    const parentTurnId  = this.parentTurnId   as TurnId;
    const resolvedModel = opts.model ?? this.parentModel;
    clearTodos(subagentId);
    // Subagents get no workspace: workspaceRoot='' means "no workspace" —
    // pathInAnyWorkingDir short-circuits to false and resolvePatternRoot
    // returns no-match for session-scoped relative patterns, so a subagent
    // cannot touch the parent's workspace files unless an explicit global/
    // home-anchored (~/) allow rule permits it. Do NOT pass process.cwd().
    const permCtx       = {
      workspaceRoot: '',
      sessionId: this.parentSessionId,
      turnId: subagentId,
      internalPaths: this.scratchpadDir
        ? { turnScratchpad: this.scratchpadDir }
        : undefined,
    };

    const startedAtMs = Date.now();
    const taskId      = opts.taskId;   // undefined until V1.5 task-store wiring
    const kind        = opts.kind ?? 'fork';
    const emit = (ev: EmaStreamEvent) => this.parentEmit?.(ev);

    // Child AbortController: cascades from parent signal, but can also be aborted
    // independently via abortSubagent(subagentId) without killing the parent turn.
    const childCtrl     = new AbortController();
    const onParentAbort = () => childCtrl.abort();
    signal.addEventListener('abort', onParentAbort, { once: true });
    this.activeSubagents.set(subagentId, childCtrl);

    // claim + subagent_started emit can throw (DB write / subscriber error).
    // If they do, release the listener + map entry registered above so they
    // don't leak — the main loop's try/finally below only covers the loop body.
    try {
      // ── taskStore: register this sub-agent ──────────────────────────────
      if (this.deps.taskStore) {
        this.deps.taskStore.claim({
          taskId:    subagentId,
          sessionId: this.parentSessionId,
          turnId:    null,
          parentId:  this.parentTurnId,
        });
      }

      // ── subagent_started ────────────────────────────────────────────────
      emit({
        type: 'subagent_started',
        sessionId,
        subagentId,
        parentTurnId,
        description:   opts.description,
        model:         resolvedModel,
        kind,
        promptExcerpt: prompt.slice(0, 200),
        startedAtMs,
      });
    } catch (err) {
      signal.removeEventListener('abort', onParentAbort);
      this.activeSubagents.delete(subagentId);
      throw err;
    }

    // Tracking state for dashboard metrics
    let currentIteration = 0;
    let toolCallCount    = 0;
    const callStartMs    = new Map<string, number>();  // callId → start epoch ms
    const callIdToName   = new Map<string, string>();  // callId → tool name

    // Build initial context based on AgentKind:
    //   'fork'     — inherit parent history with a cache breakpoint on the last message
    //                so parallel sub-agents sharing the same prefix only pay for it once.
    //   'subagent' — fresh slate; only the task prompt, no parent history (saves tokens,
    //                avoids context bleed for independent workers).
    let messages: LlmMessage[];
    if (kind === 'subagent') {
      messages = [{ role: 'user', content: prompt }];
    } else {
      const sharedPrefix = this.parentMessages.map((m, i) =>
        i === this.parentMessages.length - 1 ? { ...m, cacheBreakpoint: true as const } : m,
      );
      messages = [...sharedPrefix, { role: 'user', content: prompt }];
    }

    let subagentExecutor: TurnToolExecutor | undefined;
    const buildExecutor: ExecutorFactory = ({ pushEv, signal: wakeSignal }) => {
      // Intentionally omitting `subagentSpawner` from the sub-agent's toolCtx.
      // This enforces depth=1: sub-agents cannot recursively spawn further sub-agents.
      // Nested spawning would require unbounded resource accounting, deadlock analysis
      // for mailbox cycles, and cascading abort propagation — all deferred to V2.
      const toolCtx: ToolExecutionContext = {
        sessionId,
        turnId:           subagentId as TurnId,
        workspaceRoot:    '',  // no workspace — see permCtx note above
        signal:           childCtrl.signal,
        readFileState:    new Map(),
        emit:             pushEv,
        artifactStore:    this.deps.artifactStore,
        scratchpadDir:    this.scratchpadDir,
        scratchpadAuthor: `subagent:${subagentId.slice(0, 8)}`,
      };

      const executor = new TurnToolExecutor({
        sessionId,
        turnId:     subagentId as TurnId,
        journalTurnId: this.parentTurnId as TurnId,
        allows:     name => policy.allows(name),
        tools, permission, permCtx, hooks, toolCtx,
        buildAsk:   this.deps.buildAsk,
        pushEv,
        signal:     wakeSignal,
        toolExecutionJournal: this.deps.toolExecutionJournal,
      });
      subagentExecutor = executor;
      return executor;
    };

    let fullText = '';
    let usage    = { inputTokens: 0, outputTokens: 0 };

    try {
      for await (const ev of agentLoop({
        messages, policy, buildExecutor, llm,
        providerId:           this.parentProviderId,
        model:                resolvedModel,
        signal:               childCtrl.signal,
        maxIterations:        policy.maxIterations(),
        sessionId:            this.parentSessionId,
        getScratchpadContext: this.getScratchpadContext,
        // Drain mailbox queue atomically before each LLM call so coordinator
        // messages arrive exactly once at the next iteration boundary.
        getMailboxMessages: () => {
          const queue = this.pendingMessages.get(subagentId);
          if (!queue || queue.length === 0) return [];
          const msgs = [...queue];
          queue.length = 0;
          return msgs;
        },
      })) {
        const elapsedMs = Date.now() - startedAtMs;

        switch (ev.type) {

          // ── New iteration — card progress + detail heartbeat ─────────────
          case 'loop_iteration':
            currentIteration = ev.n;
            emit({
              type: 'subagent_progress',
              sessionId, subagentId,
              iteration:     currentIteration,
              elapsedMs,
              toolCallCount,
            });
            emit({
              type: 'subagent_stream',
              sessionId, subagentId,
              ev: { type: 'iteration', sessionId, subagentId, taskId, n: currentIteration, elapsedMs },
            });
            break;

          // ── Text streaming ───────────────────────────────────────────────
          case 'loop_text_delta':
            emit({
              type: 'subagent_stream',
              sessionId, subagentId,
              ev: { type: 'text_delta', sessionId, subagentId, taskId, delta: ev.delta },
            });
            break;

          // ── Reasoning / thinking ─────────────────────────────────────────
          case 'loop_thinking_delta':
            emit({
              type: 'subagent_stream',
              sessionId, subagentId,
              ev: { type: 'reasoning_delta', sessionId, subagentId, taskId, delta: ev.delta },
            });
            break;

          // 子 Agent 仍属于父 Turn；兼容降级必须进入同一条结构化 SSE，不能丢在内部循环。
          case 'loop_request_degraded':
            emit({
              type: 'request_degraded',
              sessionId,
              turnId: parentTurnId,
              attempt: ev.attempt,
              reason: `子 Agent ${subagentId}：${ev.reason}`,
              removed: ev.removed,
              replacements: ev.replacements,
            });
            break;

          // ── Tool call dispatched ─────────────────────────────────────────
          case 'loop_tool_complete':
            toolCallCount++;
            callStartMs.set(ev.callId, Date.now());
            callIdToName.set(ev.callId, ev.name);
            emit({
              type: 'subagent_stream',
              sessionId, subagentId,
              ev: {
                type: 'tool_call', sessionId, subagentId, taskId,
                callId: ev.callId, name: ev.name, args: ev.args, iteration: currentIteration,
              },
            });
            break;

          // ── Tool result from executor relay ──────────────────────────────
          case 'loop_relay': {
            const inner = ev.ev;
            if (inner.type === 'tool_result') {
              const name       = callIdToName.get(inner.callId) ?? 'unknown';
              const durationMs = callStartMs.has(inner.callId)
                ? Date.now() - callStartMs.get(inner.callId)!
                : 0;
              callStartMs.delete(inner.callId);

              const isError = !!inner.error;
              const raw     = isError
                ? inner.error!.message
                : typeof inner.output === 'string'
                  ? inner.output
                  : JSON.stringify(inner.output ?? '');
              const excerpt = raw.slice(0, RESULT_EXCERPT_MAX);
              const bytes   = Buffer.byteLength(raw, 'utf8');

              emit({
                type: 'subagent_stream',
                sessionId, subagentId,
                ev: {
                  type: 'tool_result',
                  sessionId, subagentId, taskId,
                  callId: inner.callId,
                  name,
                  excerpt,
                  bytes,
                  isError,
                  error:     inner.error as ToolError | undefined,
                  durationMs,
                },
              });
            }
            break;
          }

          // ── Turn complete — collect final text + usage ───────────────────
          case 'loop_done':
            fullText = ev.fullText;
            usage    = {
              inputTokens:  ev.state.usage.inputTokens,
              outputTokens: ev.state.usage.outputTokens,
            };
            break;
        }
      }

      // agentLoop 在 AbortSignal 触发时会以 loop_done 正常收束；这里必须重新映射
      // 为子任务取消，不能把用户取消误报成 subagent_completed。
      if (childCtrl.signal.aborted) {
        throw new Error(signal.aborted ? 'Parent turn aborted' : 'Sub-agent aborted by user');
      }

      // ── subagent_completed ──────────────────────────────────────────────
      const durationMs = Date.now() - startedAtMs;
      emit({
        type: 'subagent_completed',
        sessionId, subagentId,
        outputExcerpt:  fullText.slice(0, OUTPUT_EXCERPT_MAX),
        iterationCount: currentIteration,
        toolCallCount,
        stats: { inputTokens: usage.inputTokens, outputTokens: usage.outputTokens, durationMs },
      });

      this.deps.taskStore?.complete(subagentId, {
        iterations:   currentIteration,
        inputTokens:  usage.inputTokens,
        outputTokens: usage.outputTokens,
      });

      return { output: fullText, usage };

    } catch (err) {
      const elapsedMs = Date.now() - startedAtMs;
      // childCtrl.signal covers both parent cascade and per-agent abort.
      // Distinguish reason by checking the parent signal separately.
      const isAbort = childCtrl.signal.aborted;
      const message = err instanceof Error ? err.message : String(err);

      // 子 Agent 也必须遵守 Turn 终态晚于工具终态的约束。
      await subagentExecutor?.shutdown(isAbort ? 'subagent_aborted' : 'subagent_failed');

      if (isAbort) {
        const reason = signal.aborted
          ? 'parent_aborted'
          : this.stoppingReason ?? 'user_aborted';
        emit({ type: 'subagent_aborted', sessionId, subagentId, reason, elapsedMs });
        this.deps.taskStore?.cancel(subagentId, reason);
      } else {
        emit({ type: 'subagent_failed', sessionId, subagentId, error: message, atIteration: currentIteration, elapsedMs });
        this.deps.taskStore?.fail(subagentId, message);
      }

      throw err;

    } finally {
      signal.removeEventListener('abort', onParentAbort);
      this.activeSubagents.delete(subagentId);
      clearTodos(subagentId);
    }
  }
}
