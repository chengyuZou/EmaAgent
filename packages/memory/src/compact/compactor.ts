// 执行 Memory 上下文压缩，并保证返回消息满足当前模型的硬 Token 预算。
import { randomUUID } from 'node:crypto';
import {
  asCompactionId,
  type EmaStreamEvent,
  type SessionId,
  type TurnId,
  type TurnMode,
  type MessageBlocks,
} from '@ema-agent/contracts';
import type { LlmToolDef, Message as ModelMessage } from '@ema-agent/llm';
import { estimateLlmInputTokens } from '@ema-agent/token';
import type { MemoryDeps } from '../deps.js';
import type { CompactResult, MemorySettings } from '../types.js';
import type { ResolvedSessionOverrides } from '../maintenance/overrides.js';
import { microCompact }          from './micro.js';
import { runMacroCompaction }    from './macro.js';
import { buildPostCompactRestore } from './restore.js';
import { findSafeCutPoint, macroFailureReason } from './safe-cut.js';
import { sanitizeCompactionMessages } from './sanitize.js';
import { fitCompactionContext } from './budget.js';

export interface CompactionArgs {
  sessionId:           SessionId;
  turnId:              TurnId;
  mode:                TurnMode;
  messages:            ModelMessage[];
  modelContextWindow:  number;
  tools?:               readonly LlmToolDef[];
  providerId?:         string;
  model?:              string;
  recentFiles?:        ReadonlyArray<{ path: string; content: string; mtimeMs: number }>;
  signal?:             AbortSignal;
  emit?:               (event: EmaStreamEvent) => void;
}

export async function runCompaction(
  deps:                MemoryDeps,
  settings:            MemorySettings,
  getSessionOverrides: (sessionId: SessionId) => ResolvedSessionOverrides,
  args:                CompactionArgs,
): Promise<CompactResult> {
  const now          = Date.now();
  const safeMessages = sanitizeCompactionMessages(args.messages);
  const estimateContext = (messages: readonly ModelMessage[]): number =>
    estimateLlmInputTokens(messages, { tools: args.tools }).totalTokens;
  const toolTokens = estimateLlmInputTokens([], { tools: args.tools }).totalTokens;
  const beforeTokens = estimateContext(safeMessages);

  if (!settings.enabled) {
    return { status: 'not_needed', reason: 'disabled', messages: safeMessages, macroRan: false, microCleared: 0, beforeTokens, afterTokens: beforeTokens, savedTokens: 0 };
  }

  const overrides = getSessionOverrides(args.sessionId);
  if (!overrides.compaction) {
    return { status: 'not_needed', reason: 'session_disabled', messages: safeMessages, macroRan: false, microCleared: 0, beforeTokens, afterTokens: beforeTokens, savedTokens: 0 };
  }

  const buffer    = settings.compaction.bufferTokens;
  const threshold = args.modelContextWindow - buffer;

  // Stage A: micro
  const micro    = microCompact(safeMessages, { keepRecent: 6 });
  let working    = micro.messages;
  let estimated  = estimateContext(working);

  if (estimated <= threshold) {
    return { status: 'not_needed', reason: 'below_threshold', messages: working, macroRan: false, microCleared: micro.cleared, beforeTokens, afterTokens: estimated, savedTokens: beforeTokens - estimated };
  }

  // Stage B: macro
  const tailSize = Math.max(8, Math.ceil(working.length * 0.25));
  if (working.length <= tailSize) {
    return { status: 'not_needed', reason: 'insufficient_history', messages: working, macroRan: false, microCleared: micro.cleared, beforeTokens, afterTokens: estimated, savedTokens: beforeTokens - estimated };
  }

  const safeCut = findSafeCutPoint(working, working.length - tailSize);
  // Empty head (safeCut === 0) means nothing can be safely compacted off the
  // front. Bail before emitting memory_compaction_started — running macro
  // compaction on an empty head would only fail and emit a misleading
  // started→failed pair for a compaction that was never viable.
  if (safeCut === 0) {
    return { messages: working, macroRan: false, microCleared: micro.cleared,
             status: 'skipped', reason: 'no_safe_cut', beforeTokens, afterTokens: estimated,
             savedTokens: beforeTokens - estimated };
  }
  const head    = working.slice(0, safeCut);
  const tail    = working.slice(safeCut);

  const compactionId = asCompactionId(randomUUID());
  const beforeCompact = deps.hookBus
    ? await deps.hookBus.trigger('beforeCompact', {
        payload: { compactionId, messageCount: working.length, tokenEstimate: estimated },
        turnId: args.turnId,
        sessionId: args.sessionId,
        signal: args.signal,
        emit: args.emit,
      })
    : undefined;

  if (beforeCompact?.kind === 'abort') {
    args.emit?.({
      type: 'memory_compaction_skipped',
      compactionId,
      sessionId: args.sessionId,
      turnId: args.turnId,
      mode: args.mode,
      reason: 'hook_aborted',
      message: beforeCompact.reason,
      beforeTokens,
      afterTokens: estimated,
      durationMs: Date.now() - now,
    });
    return {
      status: 'skipped',
      reason: 'hook_aborted',
      detail: beforeCompact.reason,
      messages: working,
      macroRan: false,
      microCleared: micro.cleared,
      beforeTokens,
      afterTokens: estimated,
      savedTokens: beforeTokens - estimated,
    };
  }

  args.emit?.({ type: 'memory_compaction_started', compactionId, sessionId: args.sessionId, turnId: args.turnId, mode: args.mode, beforeTokens });

  const result = await runMacroCompaction({
    llm:                deps.llm,
    providerId:         args.providerId ?? deps.llm.firstProviderId() ?? '',
    model:              args.model      ?? deps.llm.defaultModelFor(args.providerId ?? deps.llm.firstProviderId() ?? '') ?? '',
    mode:               args.mode,
    toCompact:          head,
    modelContextWindow: args.modelContextWindow,
    signal:             args.signal,
  });

  if (!result.succeeded || !result.summary) {
    args.emit?.({
      type: 'memory_compaction_failed',
      compactionId,
      sessionId: args.sessionId, turnId: args.turnId, mode: args.mode,
      beforeTokens, afterTokens: estimated,
      error: macroFailureReason(result.attempts),
      durationMs: Date.now() - now,
    });
    return {
      status: 'failed',
      reason: 'macro_failed',
      detail: macroFailureReason(result.attempts),
      messages: working,
      macroRan: false,
      microCleared: micro.cleared,
      beforeTokens,
      afterTokens: estimated,
      savedTokens: beforeTokens - estimated,
    };
  }

  const restore = buildPostCompactRestore(deps, { sessionId: args.sessionId, mode: args.mode, recentFiles: args.recentFiles });
  const fitted = fitCompactionContext({
    summary: result.summary,
    restore,
    tail,
    mode: args.mode,
    tokenLimit: threshold,
    fixedTokens: toolTokens,
  });
  if (!fitted) {
    const error = `Compacted context still exceeds hard token limit ${threshold}`;
    args.emit?.({
      type: 'memory_compaction_failed',
      compactionId,
      sessionId: args.sessionId, turnId: args.turnId, mode: args.mode,
      beforeTokens, afterTokens: estimated,
      error,
      durationMs: Date.now() - now,
    });
    return {
      status: 'failed',
      reason: 'macro_failed',
      detail: error,
      messages: working,
      macroRan: false,
      microCleared: micro.cleared,
      beforeTokens,
      afterTokens: estimated,
      savedTokens: beforeTokens - estimated,
    };
  }

  deps.session.appendMessage({
    turnId: args.turnId,
    sessionId: args.sessionId,
    role: 'user',
    kind: 'summary',
    blocks: fitted.summary satisfies MessageBlocks,
  });
  working = fitted.messages;
  const afterTokens = fitted.afterTokens;

  args.emit?.({
    type: 'memory_compaction_completed',
    compactionId,
    sessionId: args.sessionId, turnId: args.turnId, mode: args.mode,
    beforeTokens, afterTokens, savedTokens: Math.max(0, beforeTokens - afterTokens),
    durationMs: Date.now() - now,
  });
  await deps.hookBus?.trigger('afterCompact', {
    payload: { compactionId, before: beforeTokens, after: afterTokens, method: 'macro' },
    turnId: args.turnId,
    sessionId: args.sessionId,
    signal: args.signal,
    emit: args.emit,
  });

  return { status: 'completed', messages: working, macroRan: true, microCleared: micro.cleared, beforeTokens, afterTokens, savedTokens: Math.max(0, beforeTokens - afterTokens) };
}
