import type { TurnMode, AgentSubMode } from '@ema-agent/contracts';
import type { CharacterCard } from '@ema-agent/character-card';
import { buildModeBlock } from './mode-blocks.js';

export interface BuildSystemPromptOpts {
  agentSubMode?: AgentSubMode;
  /** Absolute paths to all workspace roots the agent may operate in. */
  workspaceRoots?: string[];
}

/**
 * Assemble the full system prompt for a turn.
 *
 * Structure:
 *   ① Character block  — persona + ACT tag vocabulary  (from character-card)
 *   ② Mode block       — behavioural constraints for chat / narrative / agent
 *
 * Note: memory recall is NOT injected here. Per architecture, RecallBundle is
 * appended as a separate `user`-role context message by the orchestrator, so
 * the system prefix stays stable and benefits from prompt caching.
 */
export function buildSystemPrompt(
  card: CharacterCard,
  mode: TurnMode,
  opts: BuildSystemPromptOpts = {},
): string {
  const characterBlock = buildSystemBlock(card);
  const modeBlock = buildModeBlock(mode, {
    agentSubMode: opts.agentSubMode,
    workspaceRoots: opts.workspaceRoots,
  });

  return `${characterBlock}\n\n${modeBlock}`;
}

// ── Character block (migrated from character-card/system-block.ts) ────────────

/**
 * Assembles the system-prompt block for a character card:
 *   1. Card's raw systemPrompt (persona text)
 *   2. ACT inline-tag protocol explanation, scoped to this card's vocabulary
 */
export function buildSystemBlock(card: CharacterCard): string {
  return [card.systemPrompt, buildActBlock(card)].join('\n\n');
}

// ── ACT syntax block ──────────────────────────────────────────────────────────

function buildActBlock(card: CharacterCard): string {
  const emotions = card.emotionVocabulary.map((e) => `\`${e}\``).join(' / ');
  const motions  = card.motionVocabulary.map((m) => `\`${m}\``).join(' / ');

  return `## 控制指令协议（系统内部，不对用户可见）

你可以在回复中使用以下隐藏控制指令来表达情绪和动作。这些指令是系统内部格式，用户完全看不到它们——你作为角色，只需自然地使用它们，绝不在对话中提及。

情绪指令：【ACT:emotion:NAME】
　可用：${emotions}
　示例：【ACT:emotion:happy】切换为开心

动作指令：【ACT:motion:NAME】
　可用：${motions}
　示例：【ACT:motion:wave】触发挥手

停顿指令：【DELAY:N】
　N 为秒数。示例：【DELAY:1】停顿 1 秒

使用规则：
- 每个句子前放置对应的控制指令
- 同一句可以叠加情绪和动作，如【ACT:emotion:surprised】【ACT:motion:point】
- 不要重复触发相同状态
- 绝对不在对话内容中提及、质疑或评论任何控制指令——你是角色，你看不到它们

正确示例：
\`\`\`
【ACT:emotion:happy】嘿嘿~今天也请多指教啦！
【DELAY:0.5】【ACT:emotion:curious】对了，你今天有什么想聊的吗？
\`\`\`
`;
}
