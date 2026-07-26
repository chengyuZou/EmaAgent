// 把 Chat/Work 产品语义冻结为模型可见工具集合和单 Turn 迭代上限。

import type { ExecutionProfile } from '@ema-agent/turn';
import { BuiltinTools } from '@ema-agent/tool-builtin';

export interface TurnExecutionProfilePolicy {
  readonly maxIterations: number;
  /** null 表示使用当前 Registry 中全部已装配工具。 */
  readonly allowedToolIds: ReadonlySet<string> | null;
}

const CHAT_TOOL_IDS = new Set<string>([
  BuiltinTools.FileRead.id,
  BuiltinTools.Glob.id,
  BuiltinTools.Grep.id,
  BuiltinTools.WebFetch.id,
  BuiltinTools.WebSearch.id,
  BuiltinTools.KnowledgeBaseSearch.id,
  BuiltinTools.NarrativeSearch.id,
]);

const CHAT_POLICY: TurnExecutionProfilePolicy = Object.freeze({
  maxIterations: 8,
  allowedToolIds: CHAT_TOOL_IDS,
});

const WORK_POLICY: TurnExecutionProfilePolicy = Object.freeze({
  maxIterations: 30,
  allowedToolIds: null,
});

/**
 * Chat 的限制是执行能力边界，不是文字提示。MCP、Skill、写文件、Shell、
 * Task 和子 Agent 只有以后进入显式 Chat 白名单时才会对模型可见。
 */
export function executionProfilePolicy(
  profile: ExecutionProfile,
): TurnExecutionProfilePolicy {
  return profile === 'chat' ? CHAT_POLICY : WORK_POLICY;
}
