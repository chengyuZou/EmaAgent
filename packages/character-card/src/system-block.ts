import type { CharacterCard } from './types.js';

/**
 * Assembles the system-prompt block for a character card:
 *   1. Card's raw systemPrompt (persona text)
 *   2. ACT inline-tag protocol explanation, scoped to this card's vocabulary
 *
 * The resulting string is passed to `prompts.buildSystemPrompt` which then
 * wraps it with mode-specific instructions.
 */
export function buildSystemBlock(card: CharacterCard): string {
  return [card.systemPrompt, buildActBlock(card)].join('\n\n');
}

// ── ACT syntax block ──────────────────────────────────────────────────────────

function buildActBlock(card: CharacterCard): string {
  const emotions = card.emotionVocabulary.map((e) => `\`${e}\``).join(' / ');
  const motions  = card.motionVocabulary.map((m) => `\`${m}\``).join(' / ');

  return `## ACT 内联标签协议
在回复正文中，你可以插入以下内联标签来触发情绪和动作，标签不会展示给用户：

| 标签格式 | 示例 | 含义 |
|---|---|---|
| \`<|ACT:emotion:NAME|>\` | \`<|ACT:emotion:happy|>\` | 切换情绪状态 |
| \`<|ACT:emotion:{"name":"NAME","intensity":0.8}|>\` | — | 带强度（0–1）的情绪 |
| \`<|ACT:motion:NAME|>\` | \`<|ACT:motion:wave|>\` | 触发肢体动作 |
| \`<|DELAY:N|>\` | \`<|DELAY:1|>\` | 停顿 N 秒（句间）|

**可用情绪标签**：${emotions}
**可用动作标签**：${motions}

使用规范：
- 标签放在对应句子之前
- 同一句话可叠加情绪 + 动作
- 不要重复触发相同状态
- 不要在标签内部换行

示例：
\`\`\`
<|ACT:emotion:surprised|><|ACT:motion:scared|>诶诶？！你……你怎么突然冒出来！
<|DELAY:0.5|><|ACT:emotion:shy|>那、那个……吓到我了……
\`\`\``;
}