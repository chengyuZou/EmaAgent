import type { HookBus } from '@ema-agent/hook';
import type {
  TurnMode, SessionId, TurnId,
} from '@ema-agent/contracts';
import type { LlmRouter } from '@ema-agent/llm';
import type { SessionStore } from '@ema-agent/session';
import type { MemoryPlanner } from './planner.js';
import { bestEffortAsync } from './best-effort.js';

// ── Recent files extractor (agent restore) ───────────────────────────────────

/**
 * Caller plugs in a function that returns the recently-touched files for a
 * given session. Conversation engine has no notion of file reads, so this is
 * optional and defaults to "none". Agent engine wires its readFileState here.
 */
export type RecentFilesProvider = (
  sessionId: SessionId,
) => ReadonlyArray<{ path: string; content: string; mtimeMs: number }>;

// ── Hook deps ────────────────────────────────────────────────────────────────

export interface MemoryHooksDeps {
  planner:       MemoryPlanner;
  session:       SessionStore;
  llm:           LlmRouter;
  /** Fallback when the engine doesn't pass model in meta. Defaults to 128K. */
  defaultContextWindow?: number;
  /**
   * Look up the context window for a model name.
   * Implemented by the orchestrator via llm_model_catalog (DB).
   * Returns 0 when the model is unknown → falls back to defaultContextWindow.
   */
  getContextWindow: (model: string) => number;
  recentFiles?:  RecentFilesProvider;
}

// ── Hook registration ────────────────────────────────────────────────────────

/**
 * Register all memory hooks on the provided bus.
 *
 *   beforeLlm (priority 20): compaction check + recall + context injection
 *   onTurnEnd (priority 50): pending fragments append + maybe enqueue extraction
 *
 * Priority 20 runs AFTER prompts:buildSystem (10) so the system prompt is
 * already in place. We mutate payload.messages only.
 *
 * Returns an unregister function for tests.
 */
export function registerMemoryHooks(
  bus: HookBus,
  deps: MemoryHooksDeps,
): () => void {
  const { planner } = deps;

  // ── beforeLlm ───────────────────────────────────────────────────────────────
  const offBeforeLlm = bus.register(
    'beforeLlm',
    async (ctx) => {
      const mode       = (ctx.meta['mode']       as TurnMode | undefined) ?? 'chat';
      const userInput  = (ctx.meta['userInput']  as string   | undefined) ?? '';
      const signal     = ctx.meta['signal']      as AbortSignal | undefined;
      // Engine sets model + providerId in meta so context window + compaction
      // are always per-turn accurate.
      const model      = ctx.meta['model']      as string | undefined;
      const providerId = ctx.meta['providerId'] as string | undefined;

      const window = resolveContextWindow(deps, model);
      const recent = deps.recentFiles?.(ctx.sessionId);

      const t0 = Date.now();
      const result = await planner.applyToBeforeLlm({
        sessionId:          ctx.sessionId,
        turnId:             ctx.turnId,
        mode,
        userInput,
        messages:           ctx.payload.messages,
        modelContextWindow: window,
        providerId,
        compactionModel:    model,
        recentFiles:        recent,
        signal,
        emit:               ctx.emit,
      });

      return {
        kind: 'replace',
        payload: {
          systemPrompt: ctx.payload.systemPrompt,
          messages:     result.messages,
        },
      };
    },
    { name: 'memory:beforeLlm', priority: 20, critical: false },
  );

  // ── onTurnEnd ───────────────────────────────────────────────────────────────
  const offOnTurnEnd = bus.register(
    'onTurnEnd',
    async (ctx) => {
      await bestEffortAsync('onTurnEnd extraction',
        () => runOnTurnEnd(deps.session, planner, ctx.sessionId, ctx.turnId), undefined);
      return { kind: 'continue' };
    },
    { name: 'memory:onTurnEnd', priority: 50, critical: false, parallel: true },
  );

  return () => {
    offBeforeLlm();
    offOnTurnEnd();
  };
}

// ── Internals ────────────────────────────────────────────────────────────────

function resolveContextWindow(
  deps:  MemoryHooksDeps,
  model: string | undefined,
): number {
  if (model) {
    const fromCatalog = deps.getContextWindow(model);
    if (fromCatalog > 0) return fromCatalog;
  }
  return deps.defaultContextWindow ?? 128_000;
}

async function runOnTurnEnd(
  session: SessionStore,
  planner: MemoryPlanner,
  sessionId: SessionId,
  turnId: TurnId,
): Promise<void> {
  const turn = session.getTurn(turnId);
  if (!turn) return;

  const messages = session.loadMessagesForTurn(turnId);
  // First user message = actual user query; subsequent user messages are tool results.
  const userMsg = messages.find(m => m.role === 'user' && m.kind === 'normal');
  // Collect ALL assistant messages — agent turns can have multiple (think→act→think→respond).
  const assistantTexts = messages
    .filter(m => m.role === 'assistant' && m.kind === 'normal')
    .map(m => extractText(m.blocks))
    .filter(t => t.length > 0);

  const userText      = extractText(userMsg?.blocks);
  const assistantText = assistantTexts.join('\n\n');

  await planner.afterTurn({
    sessionId,
    turnId,
    mode:          turn.mode,
    userText,
    assistantText,
  });
}

function extractText(blocks: unknown): string {
  if (!blocks) return '';
  if (typeof blocks === 'string') return blocks;
  if (Array.isArray(blocks)) {
    const parts: string[] = [];
    for (const b of blocks) {
      if (!b || typeof b !== 'object') continue;
      const entry = b as Record<string, unknown>;
      if (entry['type'] === 'text' && typeof entry['text'] === 'string') {
        parts.push(entry['text']);
      } else if (entry['type'] === 'thinking' && typeof entry['thinking'] === 'string') {
        // Skip thinking blocks — internal reasoning, not user-facing content
      }
    }
    return parts.join('\n');
  }
  return '';
}
