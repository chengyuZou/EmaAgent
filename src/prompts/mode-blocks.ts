// 为旧 TurnMode 生成迁移期行为约束，Chat/Work 接入后删除。

import type { TurnMode } from '@ema-agent/contracts';

export interface ModeBlockOpts {
  /** Agent 允许操作的工作区根目录。null/undefined = 未设置。 */
  workspaceRoot?: string | null;
}

/**
 * 返回模式专属的指令块，拼在角色块后面。
 * Character 已独立提供角色表达片段；本模块只保留旧 session 模式行为。
 */
export function buildModeBlock(mode: TurnMode, opts: ModeBlockOpts = {}): string {
  switch (mode) {
    case 'chat':      return chatBlock();
    case 'narrative': return narrativeBlock();
    case 'agent':     return agentBlock(opts);
  }
}

// ── Chat ──────────────────────────────────────────────────────────────────────

function chatBlock(): string {
  return `## 当前模式：日常对话（chat）
- 保持角色人设，自然口语化回复
- 回复长度匹配用户语气：对方简短则简短，对方展开则展开
- 可以使用 ACT 标签表达情绪和动作
- 遇到不懂的事可以说「我不太确定，你要不要查一下？」，不要编造信息
- 不调用任何工具`;
}

// ── Narrative ─────────────────────────────────────────────────────────────────

function narrativeBlock(): string {
  return `## 当前模式：剧情叙事（narrative）
- 以角色身份进行沉浸式剧情交互，参考提供的剧情记忆片段
- 若上下文提供了记忆召回内容，优先与其保持一致，不要自行发明未出现的设定
- 允许适度扩充细节，但不得与核心设定矛盾
- 使用 ACT 标签配合情绪丰富的叙事体验
- 不调用工具；若需要查询剧情信息，直接从上下文记忆中提取`;
}

// ── Agent ─────────────────────────────────────────────────────────────────────

function agentBlock({ workspaceRoot }: ModeBlockOpts): string {
  const wsNote = workspaceRoot
    ? `当前允许操作的工作区目录：\`${workspaceRoot}\`\n所有文件操作必须限定在该目录范围内。\n`
    : '';

  return `## 当前模式：Agent 任务（agent）
${wsNote}工作原则：
1. 先理解任务再选工具，可在同一轮批量调用多个独立工具
2. 需要读取文件时先读后分析，不凭空猜测内容
3. 工具失败时把错误信息告知用户，并给出下一步方案
4. 代码修改必须通过 artifact 系统展示，不在聊天气泡里粘贴大段 diff
5. 同一工具连续报错超过一次，改用其他工具或向用户说明限制
6. 最终回答：先「结论」，再「关键依据」，最后「可执行下一步」

使用 ACT 标签保持角色感，但任务场景下情绪表达应简洁，不喧宾夺主。`;
}
