// 这里注册 prompts:buildSystem hook：在 beforeLlm 把 system prompt（角色卡 + 模式块）插到 messages[0]。

import type { HookBus } from '@ema-agent/hook';
import type { CharacterCardStore } from '@ema-agent/characters';
import { buildSystemPrompt } from './build.js';

// ── Hook 依赖 ──────────────────────────────────────────────────────────────────

export interface PromptsHooksDeps {
  card: CharacterCardStore;
}

// ── Hook 注册 ──────────────────────────────────────────────────────────────────

/**
 * 在给定总线上注册 `prompts:buildSystem` hook。
 *
 *   beforeLlm（优先级 10）：用当前激活的角色卡 + turn 的模式块构造 system
 *   角色消息，插到 messages[0]。
 *
 * 优先级 10 让它排在 memory 的 beforeLlm hook（优先级 20）之前，这样
 * memory 的压缩 + 召回跑的时候，system prompt 已经是 payload.messages 的第一个元素。
 *
 * 返回反注册函数供测试用。
 */
export function registerPromptsHooks(
  bus: HookBus,
  deps: PromptsHooksDeps,
): () => void {
  return bus.register(
    'beforeLlm',
    async (ctx) => {
      const card    = deps.card.current();
      const mode = ctx.payload.mode;
      const workspaceRoot = ctx.payload.workspaceRoot;

      const systemPrompt = buildSystemPrompt(card, mode, { workspaceRoot });

      // messages 数组不是以 system 开头时，前面插一条 system 消息。
      // （防御性--调用方预先塞了 system 行的也支持。）
      const messages = ctx.payload.messages;
      const stableSystem = {
        role: 'system' as const,
        content: systemPrompt,
        cacheBreakpoint: true as const,
      };
      const next = messages[0]?.role === 'system'
        ? [stableSystem, ...messages.slice(1)]
        : [stableSystem, ...messages];

      return {
        kind: 'replace',
        payload: {
          ...ctx.payload,
          messages: next,
        },
      };
    },
    { name: 'prompts:buildSystem', priority: 10 },
  );
}
