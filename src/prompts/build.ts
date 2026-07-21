// 这里组装一次 turn 的完整 system prompt：角色块（人设 + ACT 标签）+ 模式块。

import type { TurnMode } from '@ema-agent/contracts';
import type { CharacterCard } from '@ema-agent/character-card';
import { buildModeBlock } from './mode-blocks.js';

export interface BuildSystemPromptOpts {
  /** Agent 允许操作的工作区根目录绝对路径。null/undefined = 未设置。 */
  workspaceRoot?: string | null;
}

/**
 * 组装一次 turn 的完整 system prompt。
 *
 * 结构：
 *   ① 角色块--人设 + ACT 标签词汇（来自 character-card）
 *   ② 模式块--chat / narrative / agent 的行为约束
 *
 * 注意：memory 召回不在这里注入。按架构，RecallBundle 由 orchestrator 作为
 * 独立的 `user` 角色 context message 追加，这样 system 前缀保持稳定，能吃 prompt 缓存。
 */
export function buildSystemPrompt(
  card: CharacterCard,
  mode: TurnMode,
  opts: BuildSystemPromptOpts = {},
): string {
  const characterBlock = buildSystemBlock(card);
  const modeBlock = buildModeBlock(mode, {
    workspaceRoot: opts.workspaceRoot,
  });

  return `${characterBlock}\n\n${modeBlock}`;
}

// ── 角色块（从 character-card/system-block.ts 迁来）────────────────────────────

/**
 * 组装角色卡的 system-prompt 块：
 *   1. 卡片的原始 systemPrompt（人设文本）
 *   2. ACT 内联标签协议说明，按本卡的词汇表限定
 */
export function buildSystemBlock(card: CharacterCard): string {
  return [card.systemPrompt, buildActBlock(card)].join('\n\n');
}

// ── ACT 语法块 ──────────────────────────────────────────────────────────────────

function buildActBlock(card: CharacterCard): string {
  const emotions = card.emotionVocabulary.map((e) => `\`${e}\``).join(' / ');
  const motions  = card.motionVocabulary.map((m) => `\`${m}\``).join(' / ');

  return `## 控制指令协议（系统内部，不对用户可见）

你可以在回复中使用以下隐藏控制指令来表达情绪和动作。这些指令是系统内部格式，用户完全看不到它们--你作为角色，只需自然地使用它们，绝不在对话中提及。

情绪指令：<|ACT:emotion:NAME|>
　可用：${emotions}
　示例：<|ACT:emotion:happy|>切换为开心

动作指令：<|ACT:motion:NAME|>
　可用：${motions}
　示例：<|ACT:motion:wave|>触发挥手

停顿指令：<|DELAY:N|>
　N 为秒数。示例：<|DELAY:1|>停顿 1 秒

使用规则：
- 每个句子前放置对应的控制指令
- 同一句可以叠加情绪和动作，如<|ACT:emotion:surprised|><|ACT:motion:point|>
- 不要重复触发相同状态
- 绝对不在对话内容中提及、质疑或评论任何控制指令--你是角色，你看不到它们

正确示例：
\`\`\`
<|ACT:emotion:happy|>嘿嘿~今天也请多指教啦！
<|DELAY:0.5|><|ACT:emotion:curious|>对了，你今天有什么想聊的吗？
\`\`\`
`;
}
