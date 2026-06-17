/**
 * TurnToolExecutor — streaming tool execution with concurrency control.
 *
 * Mirrors Claude Code's StreamingToolExecutor design:
 *  - addTool() is called immediately on each tool_use_complete event, starting
 *    permission check + execution without waiting for the full LLM stream to end.
 *  - Concurrent-safe tools (isConcurrencySafe() === true) run in parallel with
 *    each other, but still wait for any in-flight non-concurrent tool to finish.
 *  - Non-concurrent tools run exclusively: they wait for the serial fence AND all
 *    currently-queued concurrent-safe tools.
 *  - Events (permission dialogs, progress, results) are pushed via pushEv() and
 *    signalled via signal() so the engine can yield them between LLM stream chunks.
 */

import type { EmaStreamEvent, ToolResultBlock, SessionId, TurnId } from '@ema-agent/contracts';
import type { ToolExecutionContext, ICommandRunner } from '@ema-agent/tool';
import type { PermissionEngine, PermissionContext } from '@ema-agent/permission';
import type { HookBus } from '@ema-agent/hook';
import type { AgentToolResultStore } from '@ema-agent/agent-context';
import type { AgentDeps } from './types.js';

// ── Internal per-tool state ───────────────────────────────────────────────────

interface TrackedTool {
  blockIndex:        number;
  id:                string;
  name:              string;
  args:              unknown;
  isConcurrencySafe: boolean;
  done:              boolean;
  result?:           ToolResultBlock;
  promise?:          Promise<void>;
}

// ── Public options ────────────────────────────────────────────────────────────

export interface TurnToolExecutorOpts {
  sessionId:   SessionId;
  turnId:      TurnId;
  /** Synchronous policy check — returns false for plan-mode-blocked tools. */
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

  constructor(private readonly opts: TurnToolExecutorOpts) {}

  /** Reset between LLM iterations. */
  reset(): void {
    this.tracked    = [];
    this.serialTail = Promise.resolve();
  }

  /**
   * Register a tool call and start executing it immediately.
   * Policy-denied and unknown tools get a synthetic error result without executing.
   * May be called while the LLM stream is still in progress.
   */
  addTool(blockIndex: number, id: string, name: string, args: unknown): void {
    const { allows, tools, pushEv } = this.opts;

    // ── Synchronous rejection paths (no async needed) ───────────────────────

    if (!allows(name)) {
      const msg = `Tool "${name}" is not available in this mode`;
      this.tracked.push({
        blockIndex, id, name, args, isConcurrencySafe: true, done: true,
        result: { type: 'tool_result', toolUseId: id, content: msg, isError: true },
      });
      pushEv({ type: 'tool_result', sessionId: this.opts.sessionId, callId: id, error: { code: 'policy/denied', message: msg } });
      return;
    }

    if (!tools.has(name)) {
      const msg = `Unknown tool: "${name}"`;
      this.tracked.push({
        blockIndex, id, name, args, isConcurrencySafe: true, done: true,
        result: { type: 'tool_result', toolUseId: id, content: msg, isError: true },
      });
      pushEv({ type: 'tool_result', sessionId: this.opts.sessionId, callId: id, error: { code: 'tool/not_found', message: msg } });
      return;
    }

    // ── Args parse error (LLM output truncated by max_tokens or provider bug) ──
    // The OpenAI adapter tags unparseable argsJson with __parse_error rather than
    // silently falling back to {} — calling a tool with wrong args causes silent
    // misbehaviour that is much harder to diagnose than an explicit error result.
    if (args !== null && typeof args === 'object' && (args as Record<string, unknown>)['__parse_error'] === true) {
      const raw = (args as Record<string, unknown>)['raw'];
      const snippet = typeof raw === 'string' ? raw.slice(0, 200) : '';
      const msg = `工具参数解析失败（模型输出可能被截断），请重试或缩短回复长度。${snippet ? `原始片段：${snippet}` : ''}`;
      this.tracked.push({
        blockIndex, id, name, args, isConcurrencySafe: true, done: true,
        result: { type: 'tool_result', toolUseId: id, content: msg, isError: true },
      });
      pushEv({ type: 'tool_result', sessionId: this.opts.sessionId, callId: id, error: { code: 'tool/args_parse_error', message: msg } });
      return;
    }

    // ── Async execution path ─────────────────────────────────────────────────

    const toolEntry        = tools.get(name);
    const isConcurrencySafe = toolEntry.isConcurrencySafe();
    const track: TrackedTool = { blockIndex, id, name, args, isConcurrencySafe, done: false };

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
      sessionId, turnId, permission, permCtx, hooks, toolCtx, tools, buildAsk, runner, pushEv, signal,
    } = this.opts;
    const { id, name, args } = track;

    try {
      // ── Tool observer hook ────────────────────────────────────────────────
      // Tool lifecycle hooks are UI/audit observers only. PermissionEngine is
      // the execution gate, and the sandbox runner is the isolation boundary.
      await hooks.trigger('beforeToolUse', {
        turnId, sessionId,
        payload: { callId: id, name, args },
        meta:    {},
      });

      // ── Permission gate ───────────────────────────────────────────────────
      // In production, buildAsk routes permission_required events through pushEv
      // into the engine's pending queue so the SSE stream delivers them immediately.
      // Tests/minimal hosts that omit buildAsk fall back to the engine-level config.ask.
      const permCtxWithAsk: PermissionContext = buildAsk
        ? { ...permCtx, ask: buildAsk({ sessionId, turnId, emit: pushEv }) }
        : permCtx;

      const outcome = await permission.gate(name, args, tools.get(name).permissionMeta, permCtxWithAsk);

      if (!outcome.granted) {
        const reason = `Permission denied: ${outcome.reason}`;
        track.result = { type: 'tool_result', toolUseId: id, content: reason, isError: true };
        pushEv({ type: 'tool_result', sessionId: this.opts.sessionId, callId: id, error: { code: 'permission/denied', message: reason } });
        await hooks.trigger('onToolFailure', {
          turnId, sessionId,
          payload: { callId: id, name, error: reason },
          meta:    {},
        });
        return;
      }

      // ── Execute ───────────────────────────────────────────────────────────
      let output: unknown;
      let isError = false;

      try {
        output = await tools.dispatch(name, args, toolCtx);
        // Push result event BEFORE await-ing hooks so the engine can yield it
        // immediately. track.done is set in finally after hooks complete.
        pushEv({ type: 'tool_result', sessionId: this.opts.sessionId, callId: id, output });
        await hooks.trigger('afterToolUse', {
          turnId, sessionId,
          payload: { callId: id, name, output },
          meta:    {},
        });
      } catch (err) {
        isError = true;
        output  = (err as Error).message;
        pushEv({ type: 'tool_result', sessionId: this.opts.sessionId, callId: id, error: { code: 'tool/error', message: output as string } });
        await hooks.trigger('onToolFailure', {
          turnId, sessionId,
          payload: { callId: id, name, error: err },
          meta:    {},
        });
      }

      const serialized = typeof output === 'string' ? output : JSON.stringify(output, null, 2);
      const { toolResultStore } = this.opts;
      let content = serialized;
      if (toolResultStore) {
        const norm = toolResultStore.maybeNormalize(id, name, serialized);
        if (norm.kind !== 'unchanged') content = norm.blockContent;
      }
      track.result = { type: 'tool_result', toolUseId: id, content, isError };

    } finally {
      // Always mark done and signal the drain loop — even if an unexpected error
      // escaped from hooks or the gate. Prevents the drain loop from deadlocking.
      if (!track.done) {
        if (!track.result) {
          const msg = 'Tool execution failed unexpectedly';
          track.result = { type: 'tool_result', toolUseId: id, content: msg, isError: true };
          pushEv({ type: 'tool_result', sessionId: this.opts.sessionId, callId: id, error: { code: 'tool/error', message: msg } });
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
}
