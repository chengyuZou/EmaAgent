import type { HookBus } from '@ema-agent/hook';
import type {
  TurnMode, AgentSubMode, SessionId, TurnId,
} from '@ema-agent/contracts';
import type { LlmRouter } from '@ema-agent/llm';
import type { ModelCatalog } from '@ema-agent/llm';
import type { SessionStore } from '@ema-agent/session';
import type { MemoryPlanner } from './planner.js';

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
  planner:        MemoryPlanner;
  session:        SessionStore;
  llm:            LlmRouter;
  modelCatalog?:  ModelCatalog;
  /** Defaults to 128_000 — most common modern context size. */
  defaultContextWindow?: number;
  recentFiles?:   RecentFilesProvider;
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
  const defaultWindow = deps.defaultContextWindow ?? 128_000;

  // ── beforeLlm ───────────────────────────────────────────────────────────────
  const offBeforeLlm = bus.register(
    'beforeLlm',
    async (ctx) => {
      const mode = (ctx.meta['mode'] as TurnMode | undefined) ?? 'chat';
      const userInput = (ctx.meta['userInput'] as string | undefined) ?? '';
      const signal    = ctx.meta['signal']    as AbortSignal | undefined;

      const window = resolveContextWindow(deps, mode, ctx.meta['subMode'] as AgentSubMode | undefined);
      const recent = deps.recentFiles?.(ctx.sessionId);

      const result = await planner.applyToBeforeLlm({
        sessionId:          ctx.sessionId,
        turnId:             ctx.turnId,
        mode,
        userInput,
        messages:           ctx.payload.messages,
        modelContextWindow: window,
        recentFiles:        recent,
        signal,
      });

      ctx.emit?.({
        type: 'system_warning',
        level: 'info',
        message:
          `memory: recall=${result.recallSummary.layer0}/${result.recallSummary.layer2}` +
          ` compaction=${result.compactionRan ? 'yes' : 'no'}` +
          ` micro_cleared=${result.microCleared}`,
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
      try {
        await runOnTurnEnd(deps.session, planner, ctx.sessionId, ctx.turnId);
      } catch {
        /* best-effort */
      }
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
  deps: MemoryHooksDeps,
  _mode: TurnMode,
  _subMode: AgentSubMode | undefined,
): number {
  // V1: use the configured default. Future work can look up the bound model
  // through ModelCatalog and return its actual context window.
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
  const userMsg     = messages.find(m => m.role === 'user'      && m.kind === 'normal');
  const assistantMsg = messages.find(m => m.role === 'assistant' && m.kind === 'normal');

  const userText      = extractText(userMsg?.blocks);
  const assistantText = extractText(assistantMsg?.blocks);

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
