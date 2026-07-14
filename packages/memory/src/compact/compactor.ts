import type { SessionId, TurnId, TurnMode, EmaStreamEvent } from '@ema-agent/contracts';
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
    return { messages: args.messages, macroRan: false, microCleared: 0, succeeded: true, beforeTokens, afterTokens: beforeTokens, savedTokens: 0 };
  }

  const overrides = getSessionOverrides(args.sessionId);
  if (!overrides.compaction) {
    return { messages: args.messages, macroRan: false, microCleared: 0, succeeded: true, beforeTokens, afterTokens: beforeTokens, savedTokens: 0 };
  }

  const buffer    = settings.compaction.bufferTokens;
  const threshold = args.modelContextWindow - buffer;

  // Stage A: micro
  const micro    = microCompact(args.messages, { keepRecent: 6 });
  let working    = micro.messages;
  let estimated  = estimateMessagesTokens(working);

  if (estimated <= threshold) {
    return { messages: working, macroRan: false, microCleared: micro.cleared, succeeded: true, beforeTokens, afterTokens: estimated, savedTokens: beforeTokens - estimated };
  }

  // Stage B: macro
  const tailSize = Math.max(8, Math.ceil(working.length * 0.25));
  if (working.length <= tailSize) {
    return { messages: working, macroRan: false, microCleared: micro.cleared, succeeded: true, beforeTokens, afterTokens: estimated, savedTokens: beforeTokens - estimated };
  }

  const safeCut = findSafeCutPoint(working, working.length - tailSize);
  // Empty head (safeCut === 0) means nothing can be safely compacted off the
  // front. Bail before emitting memory_compaction_started — running macro
  // compaction on an empty head would only fail and emit a misleading
  // started→failed pair for a compaction that was never viable.
  if (safeCut === 0) {
    return { messages: working, macroRan: false, microCleared: micro.cleared,
             succeeded: false, beforeTokens, afterTokens: estimated,
             savedTokens: beforeTokens - estimated };
  }
  const head    = working.slice(0, safeCut);
  const tail    = working.slice(safeCut);

  args.emit?.({ type: 'memory_compaction_started', sessionId: args.sessionId, turnId: args.turnId, mode: args.mode, beforeTokens });
  await deps.hookBus?.trigger('beforeCompact', {
    payload: { messageCount: working.length, tokenEstimate: estimated },
    turnId: args.turnId,
    sessionId: args.sessionId,
    signal: args.signal,
    emit: args.emit,
  });

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
      sessionId: args.sessionId, turnId: args.turnId, mode: args.mode,
      beforeTokens, afterTokens: estimated,
      error: macroFailureReason(result.attempts),
      durationMs: Date.now() - now,
    });
    return { messages: working, macroRan: false, microCleared: micro.cleared, succeeded: false, beforeTokens, afterTokens: estimated, savedTokens: beforeTokens - estimated };
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
    sessionId: args.sessionId, turnId: args.turnId, mode: args.mode,
    beforeTokens, afterTokens, savedTokens: Math.max(0, beforeTokens - afterTokens),
    durationMs: Date.now() - now,
  });
  await deps.hookBus?.trigger('afterCompact', {
    payload: { before: beforeTokens, after: afterTokens, method: 'macro' },
    turnId: args.turnId,
    sessionId: args.sessionId,
    signal: args.signal,
    emit: args.emit,
  });

  return { messages: working, macroRan: true, microCleared: micro.cleared, succeeded: true, beforeTokens, afterTokens, savedTokens: Math.max(0, beforeTokens - afterTokens) };
}
