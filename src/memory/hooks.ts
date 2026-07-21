import type { HookBus } from '@ema-agent/hooks';
import type { SessionId, TurnId } from '@ema-agent/contracts';
import type { SessionStore } from '@ema-agent/session';
import type { MemoryPlanner } from './planner.js';
import { bestEffortAsync } from './best-effort.js';

// ── Hook deps ────────────────────────────────────────────────────────────────

export interface MemoryHooksDeps {
  planner:       MemoryPlanner;
  session:       SessionStore;
}

// ── Hook registration ────────────────────────────────────────────────────────

/**
 * Turn 完成后写入待提取片段，并按策略安排长期记忆提取。
 * Recall 已由 Context Contribution 管线直接调用，不再经 beforeLlm 改写消息数组。
 */
export function registerMemoryHooks(
  bus: HookBus,
  deps: MemoryHooksDeps,
): () => void {
  return bus.register(
    'onTurnEnd',
    async (ctx) => {
      await bestEffortAsync('onTurnEnd extraction',
        () => runOnTurnEnd(deps.session, deps.planner, ctx.sessionId, ctx.turnId), undefined);
      return { kind: 'continue' };
    },
    { name: 'memory:onTurnEnd', priority: 50, critical: false, parallel: true },
  );
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
