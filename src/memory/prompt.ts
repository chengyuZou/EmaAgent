// 构建注入 system prompt 的"记忆"段:使用指引 + 两轨摘要,合成一段。
//
// 与 prompts 包解耦:prompts 的 getSystemPrompt 只接收 memorySection 字符串
// (闭包注入),不 import memory 包;本函数在 Context/Turn 装配时被调用。
// 使用指引来自 templates/memoryGuidance.md(静态),摘要来自两轨
// memory_summary.md(数据,按 summaryTokens 预算截断)。

import type { MemoryBudgets } from './capacity/budgets.js';
import { DEFAULT_MEMORY_BUDGETS } from './capacity/budgets.js';
import { readMemorySummary } from './common/memorySummary.js';
import {
  memorySummaryFile,
  relationshipMemoryDir,
  workMemoryDir,
} from './common/paths.js';
import { loadTemplate } from './templates/loader.js';

export interface BuildMemoryPromptDeps {
  /** 记忆根目录覆盖（测试/便携）；缺省用固定路径。 */
  readonly memoryRoots?: {
    readonly work?: string;
    readonly relationship?: string;
  };
  /** 每轨摘要注入 token 预算；缺省 memorySummaryTokens。 */
  readonly budgets?: MemoryBudgets;
}

/**
 * 合成"记忆"system-prompt 段:使用指引（固定）+ 两轨摘要（数据）。
 * 两轨都没有摘要时只返回使用指引（Agent 仍知道记忆系统与 Tool）。
 */
export async function buildMemoryPrompt(
  deps: BuildMemoryPromptDeps = {},
): Promise<string> {
  const guidance = await loadTemplate('memoryGuidance');
  const work = deps.memoryRoots?.work ?? workMemoryDir();
  const relationship = deps.memoryRoots?.relationship ?? relationshipMemoryDir();
  const maxTokens =
    deps.budgets?.summaryTokens ?? DEFAULT_MEMORY_BUDGETS.summaryTokens;

  const [workSummary, relationshipSummary] = await Promise.all([
    readMemorySummary(memorySummaryFile(work), maxTokens),
    readMemorySummary(memorySummaryFile(relationship), maxTokens),
  ]);

  const sections: string[] = [
    `# 记忆使用指引\n\n${guidance.trim()}`,
  ];

  const summaryParts: string[] = [];
  if (workSummary) {
    summaryParts.push(`## Work 记忆\n\n${workSummary}`);
  }
  if (relationshipSummary) {
    summaryParts.push(`## Relationship 记忆\n\n${relationshipSummary}`);
  }
  if (summaryParts.length > 0) {
    sections.push(`# 记忆摘要\n\n${summaryParts.join('\n\n')}`);
  }

  return sections.join('\n\n');
}
