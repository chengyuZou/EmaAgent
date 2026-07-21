import type { HookBus } from '@ema-agent/hook';
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
 * Register all memory hooks on the provided bus.
 *
 *   beforeLlm (priority 20): 首次逻辑调用的 recall + context injection
 *   onTurnEnd (priority 50): pending fragments append + maybe enqueue extraction
 *
 * Priority 20 runs AFTER prompts:buildSystem (10). Engine 接入 ContextAssembler
 * 前，兼容层仍把结构化贡献投影回旧 messages；Memory Planner 不再参与数组改写。
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
      // 同一 Turn 的 Agent 多轮共享用户问题；记忆不会在 Turn 中途写入，
      // 因此只在第一次逻辑调用检索一次。Hook 本身仍会在每轮触发。
      if (ctx.payload.iteration !== 1) return { kind: 'continue' };

      const { mode, userInput } = ctx.payload;
      const signal = ctx.signal;

      const result = await planner.prepareRecallContribution({
        sessionId: ctx.sessionId,
        turnId:    ctx.turnId,
        mode,
        userInput,
        signal,
        emit:      ctx.emit,
      });

      if (!result.contribution) return { kind: 'continue' };

      const messages = ctx.payload.messages;
      const lastIndex = messages.length - 1;
      const lastMessage = messages[lastIndex];
      const insertAt = lastMessage?.role === 'user' && !isToolResultMessage(lastMessage)
        ? lastIndex
        : messages.length;

      return {
        kind: 'replace',
        payload: {
          ...ctx.payload,
          messages: [
            ...messages.slice(0, insertAt),
            result.contribution.message,
            ...messages.slice(insertAt),
          ],
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

function isToolResultMessage(message: {
  readonly role: string;
  readonly content: string | readonly { readonly type: string }[];
}): boolean {
  return message.role === 'user'
    && Array.isArray(message.content)
    && message.content.some((block) => block.type === 'tool_result');
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
