// 把本轮可见 Builtin Tool 的说明书装配为 tools.usage 槽内容;MCP 与未声明说明书的工具跳过。
import { createHash } from 'node:crypto';
import type { ToolRegistry } from '@ema-agent/tools';
import type { BuiltinToolContext } from './builtinToolContext.js';
import { assembleToolPool } from './assembleToolPool.js';

export interface ToolPromptAssembly {
  readonly content: string;
  readonly version: string;
}

/**
 * hostContext 使用与执行期相同的可见性 Context:装配方(L1)以真实服务能力构造,
 * per-Turn 构造物(activeSkillState/subagentSpawner 等)以占位对象表示——
 * 可见性检查只看存在性,说明书只允许读取冻结字段,不允许调用服务。
 * allowedToolIds 是 ExecutionProfilePolicy 的 Profile 白名单(chat 收窄),null 表示不过滤。
 */
export async function assembleToolPrompt(
  registry: ToolRegistry,
  hostContext: BuiltinToolContext,
  allowedToolIds: ReadonlySet<string> | null = null,
): Promise<ToolPromptAssembly | null> {
  const assembled = assembleToolPool(registry, hostContext);
  const visible = allowedToolIds === null
    ? assembled
    : assembled.filter((tool) => allowedToolIds.has(tool.id));

  const sections: string[] = [];
  for (const tool of visible) {
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
