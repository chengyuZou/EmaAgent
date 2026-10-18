import type { LLMTool, Message } from '@ema-agent/llm';
import type { PromptBlock } from '@ema-agent/prompts';
import type { Tool, ToolPool } from '@ema-agent/tools';
import { toJSONSchema } from 'zod';
import { ContextAssemblyError } from './errors.js';
import { estimateContextUsage } from './contextUsage.js';
import type { AssembleContextInput, PreparedContext } from './types.js';

export function assembleContext(input: AssembleContextInput): PreparedContext {
  const messagesWithoutCacheBreakpoint = stripCacheBreakpoints(input.messages);
  assertNoSystemMessages(messagesWithoutCacheBreakpoint);

  const prompt = buildPromptMessages(input.systemPrompt);
  const tools = projectToolPool(input.toolPool);
  const composed = [
    ...prompt.messages,
    ...messagesWithoutCacheBreakpoint,
  ];
  const messages = markFinalCacheBreakpoint(composed);
  const usage = estimateContextUsage({
    contextWindow: input.contextWindow,
    tools,
    messages: messages,
  });

  return { messages, tools, usage };
}

export interface PromptMessages {
  readonly messages: readonly Message[];
}

export function buildPromptMessages(systemPrompt: readonly PromptBlock[]): PromptMessages {
  const blocks = systemPrompt.filter(block => block.content.trim().length > 0);
  if (blocks.length === 0) {
    throw new ContextAssemblyError(
      'context/empty-system-prompt',
      'System Prompt 不能为空.',
    );
  }

  return {
    messages: blocks.map(block => ({
      role: 'system',
      content: block.content,
      ...(block.cacheBreakpoint ? { cacheBreakpoint: true } : {}),
    })),
  };
}

function markFinalCacheBreakpoint(messages: readonly Message[]): Message[] {
  const result = [...messages];
  for (let index = result.length - 1; index >= 0; index -= 1) {
    const message = result[index];
    // 最后一个缓存标记随本次工作消息更新, 不沿用历史中的位置.
    if (!message || message.content.length === 0) continue;
    if (!message.cacheBreakpoint) result[index] = { ...message, cacheBreakpoint: true };
    break;
  }
  return result;
}

function stripCacheBreakpoints(messages: readonly Message[]): Message[] {
  return messages.map((message): Message => {
    if (!message.cacheBreakpoint) return message;
    if (message.role === 'system') return { role: 'system', content: message.content };
    if (message.role === 'user') return { role: 'user', content: message.content };
    // 保留生成来源, 让 Adapter 判断当前模型能否重放这条回复的推理内容.
    return {
      role: 'assistant',
      content: message.content,
      ...(message.generatedBy ? { generatedBy: message.generatedBy } : {}),
    };
  });
}

function assertNoSystemMessages(messages: readonly Message[]): void {
  if (!messages.some((message) => message.role === 'system')) return;
  throw new ContextAssemblyError(
    'context/system-message-outside-prompt',
    'System message 只能来自 PromptBlock 装配, 不能混入 Agent 工作消息.',
  );
}

type AnyTool = Tool<any, any, any, any>;

function projectToolPool(toolPool: ToolPool): LLMTool[] {
  return toolPool.tools.map((tool: AnyTool): LLMTool => ({
    name: tool.name,
    description: tool.description,
    inputSchema: tool.inputJsonSchemaOverride
      ? { ...tool.inputJsonSchemaOverride }
      : toJSONSchema(tool.inputSchema) as Record<string, unknown>,
  }));
}
