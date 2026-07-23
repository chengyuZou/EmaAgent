// 根据 Subagent 实际注入的运行能力，筛选模型可见且真正可执行的工具。

import type { BuiltTool } from '@ema-agent/tools';
import { BuiltinTools } from '@ema-agent/tool-builtin';

export interface SubagentToolAvailability {
  scratchpad: boolean;
  knowledgeBase: boolean;
  skills: boolean;
}

const ALWAYS_AVAILABLE_IDS: ReadonlySet<string> = new Set([
  BuiltinTools.WebFetch.id,
  BuiltinTools.WebSearch.id,
]);

const SCRATCHPAD_IDS: ReadonlySet<string> = new Set([
  BuiltinTools.ScratchpadWrite.id,
  BuiltinTools.ScratchpadRead.id,
  BuiltinTools.ScratchpadList.id,
  BuiltinTools.ScratchpadDelete.id,
  BuiltinTools.ScratchpadClear.id,
]);

/**
 * MCP 工具已经把 Server 调用封装在自身 execute 中，因此不依赖 ToolContext；
 * 内置工具则必须逐项证明所需能力已经注入，禁止按“注册了就能用”猜测。
 */
export function selectSubagentTools(
  tools: readonly BuiltTool[],
  availability: SubagentToolAvailability,
): BuiltTool[] {
  return tools.filter((tool) => {
    if (!tool.id.startsWith('builtin.')) return true;
    if (ALWAYS_AVAILABLE_IDS.has(tool.id)) return true;
    if (availability.scratchpad && SCRATCHPAD_IDS.has(tool.id)) return true;
    if (availability.knowledgeBase && tool.id === BuiltinTools.KnowledgeBaseSearch.id) return true;
    if (availability.skills && tool.id === BuiltinTools.SkillCall.id) return true;
    return false;
  });
}
