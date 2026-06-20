import { randomUUID } from 'node:crypto';
import type { LlmMessage, SessionId, TurnId, EmaStreamEvent, ToolError } from '@ema-agent/contracts';
import type { ISubagentSpawner, SubagentSpawnOpts, ToolExecutionContext } from '@ema-agent/tool';
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
  private readonly activeSubagents = new Map<string, AbortController>();

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

  // ── Per-subagent cancellation ─────────────────────────────────────────────

  abortSubagent(subagentId: string): void {
    this.activeSubagents.get(subagentId)?.abort();
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
    const permCtx       = { workspaceRoots: [], sessionId: this.parentSessionId };

    const startedAtMs = Date.now();
    const taskId      = opts.taskId;   // undefined until V1.5 task-store wiring
    const emit = (ev: EmaStreamEvent) => this.parentEmit?.(ev);

    // Child AbortController: cascades from parent signal, but can also be aborted
    // independently via abortSubagent(subagentId) without killing the parent turn.
    const childCtrl     = new AbortController();
    const onParentAbort = () => childCtrl.abort();
    signal.addEventListener('abort', onParentAbort, { once: true });
    this.activeSubagents.set(subagentId, childCtrl);

    // ── taskStore: register this sub-agent ────────────────────────────────
    if (this.deps.taskStore && this.deps.dataDir) {
      this.deps.taskStore.claim({
        taskId:    subagentId,
        sessionId: this.parentSessionId,
        turnId:    null,           // sub-agents have no DB turn record
        parentId:  this.parentTurnId,
        dataDir:   this.deps.dataDir,
      });
    }

    // ── subagent_started ──────────────────────────────────────────────────
    emit({
      type: 'subagent_started',
      sessionId,
      subagentId,
      parentTurnId,
      description:   opts.description,
      model:         resolvedModel,
      promptExcerpt: prompt.slice(0, 200),
      startedAtMs,
    });

    // Tracking state for dashboard metrics
    let currentIteration = 0;
    let toolCallCount    = 0;
    const callStartMs    = new Map<string, number>();  // callId → start epoch ms
    const callIdToName   = new Map<string, string>();  // callId → tool name

    // Fork: snapshot parent messages + inject the subagent prompt.
    const messages: LlmMessage[] = [
      ...this.parentMessages,
      { role: 'user', content: prompt },
    ];

    const buildExecutor: ExecutorFactory = ({ pushEv, signal: wakeSignal }) => {
      const toolCtx: ToolExecutionContext = {
        sessionId,
        turnId:           subagentId as TurnId,
        workspaceRoots:   [],
        signal:           childCtrl.signal,
        readFileState:    new Map(),
        emit:             pushEv,
        artifactStore:    this.deps.artifactStore,
        scratchpadDir:    this.scratchpadDir,
        scratchpadAuthor: `subagent:${subagentId.slice(0, 8)}`,
      };

      return new TurnToolExecutor({
        sessionId,
        turnId:     subagentId as TurnId,
        allows:     name => policy.allows(name),
        tools, permission, permCtx, hooks, toolCtx,
        buildAsk:   this.deps.buildAsk,
        pushEv,
        signal:     wakeSignal,
      });
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

      // ── subagent_completed ──────────────────────────────────────────────
      const durationMs = Date.now() - startedAtMs;
      emit({
        type: 'subagent_completed',
        sessionId, subagentId,
        outputExcerpt:  fullText.slice(0, OUTPUT_EXCERPT_MAX),
        iterationCount: currentIteration,
        toolCallCount,
        stats: { inputTokens: usage.inputTokens, outputTokens: usage.outputTokens, costUsd: 0, durationMs },
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

      if (isAbort) {
        const reason = signal.aborted ? 'parent_aborted' : 'user_aborted';
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
    }
  }
}
