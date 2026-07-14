import { randomUUID } from 'node:crypto';
import {
  asCompactionId,
  type EmaStreamEvent,
  type SessionId,
  type TurnId,
  type TurnMode,
} from '@ema-agent/contracts';
import type { LlmMessage } from '@ema-agent/llm';
import { estimateMessagesTokens } from '@ema-agent/token';
import type { MemoryDeps } from '../deps.js';
import type { CompactResult, MemorySettings } from '../types.js';
import type { ResolvedSessionOverrides } from '../maintenance/overrides.js';
import { microCompact }          from './micro.js';
import { runMacroCompaction }    from './macro.js';
import { buildPostCompactRestore } from './restore.js';
import { findSafeCutPoint, macroFailureReason } from './safe-cut.js';

export interface CompactionArgs {
  sessionId:           SessionId;
  turnId:              TurnId;
  mode:                TurnMode;
  messages:            LlmMessage[];
  modelContextWindow:  number;
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
  const beforeTokens = estimateMessagesTokens(args.messages);

  if (!settings.enabled) {
    return { status: 'not_needed', reason: 'disabled', messages: args.messages, macroRan: false, microCleared: 0, beforeTokens, afterTokens: beforeTokens, savedTokens: 0 };
  }

  const overrides = getSessionOverrides(args.sessionId);
  if (!overrides.compaction) {
    return { status: 'not_needed', reason: 'session_disabled', messages: args.messages, macroRan: false, microCleared: 0, beforeTokens, afterTokens: beforeTokens, savedTokens: 0 };
  }

  const buffer    = settings.compaction.bufferTokens;
  const threshold = args.modelContextWindow - buffer;

  // Stage A: micro
  const micro    = microCompact(args.messages, { keepRecent: 6 });
  let working    = micro.messages;
  let estimated  = estimateMessagesTokens(working);

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
    session:            deps.session,
    sessionId:          args.sessionId,
    turnId:             args.turnId,
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

  const summaryMsg: LlmMessage = {
    role:    'user',
    content: `<context-summary mode="${args.mode}">\n${result.summary}\n</context-summary>`,
  };
  const restore = buildPostCompactRestore(deps, { sessionId: args.sessionId, mode: args.mode, recentFiles: args.recentFiles });

  working = [summaryMsg, ...restore, ...tail];
  const afterTokens = estimateMessagesTokens(working);

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
