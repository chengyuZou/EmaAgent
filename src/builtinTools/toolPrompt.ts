// 把本轮可见 Builtin Tool 的说明书装配为 tools.prompt 槽内容;MCP 与未声明说明书的工具跳过。
import { createHash } from 'node:crypto';
import type { BuiltTool } from '@ema-agent/tools';
import type { BuiltinToolContext } from './builtinToolContext.js';

export interface ToolPromptAssembly {
  readonly content: string;
  readonly version: string;
}

/**
 * visibleTools 必须是执行期同一轮筛选的结果，禁止为 Prompt 重新推断能力。
 * hostContext 是真实冻结的执行 Context；说明书只能读取稳定字段，不能调用服务。
 */
export async function assembleToolPrompt(
  visibleTools: readonly BuiltTool[],
  hostContext: BuiltinToolContext,
): Promise<ToolPromptAssembly | null> {
  const sections: string[] = [];
  for (const tool of visibleTools) {
    if (tool.origin.kind !== 'builtin' || !tool.prompt) continue;
    const content = (await tool.prompt(hostContext)).trim();
    if (content) sections.push(`## ${tool.name}\n${content}`);
  }
  if (sections.length === 0) return null;

  const content = sections.join('\n\n');
  return {
    content,
    version: createHash('sha256').update(content, 'utf8').digest('hex').slice(0, 16),
  };
}
