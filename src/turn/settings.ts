// Turn 域的用户设置：工作区指令文件选择。
import { defineSetting } from '@ema-agent/settings';
import { z } from 'zod';

/**
 * 作为工作区指令注入 Context 的候选文件，用户可多选、顺序即拼接顺序。
 * V1 候选固定为两个真实存在的生态约定；EMA.md 尚未存在，不加。
 */
export const WORKSPACE_INSTRUCTION_FILE_CANDIDATES = ['CLAUDE.md', 'AGENTS.md'] as const;

export const workspaceInstructionFilesSetting = defineSetting<string[]>({
  key: 'workspace.instructionFiles',
  description: '作为工作区指令注入 Context 的候选文件（用户可多选，顺序即拼接顺序）。',
  apply: 'nextTurn',
  defaultValue: ['CLAUDE.md', 'AGENTS.md'],
  schema: z.array(z.enum(WORKSPACE_INSTRUCTION_FILE_CANDIDATES)).max(4),
});
