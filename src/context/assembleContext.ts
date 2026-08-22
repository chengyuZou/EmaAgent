// 组装一次 LLM Call 的 Provider 中立输入；是否压缩由调用方在本函数之外决定。
import type { LlmTool, Message } from '@ema-agent/llm';
import { PROMPT_DYNAMIC_BOUNDARY } from '@ema-agent/prompts';
import type { Tool, ToolPool } from '@ema-agent/tools';
import { toJSONSchema } from 'zod';
import { ContextAssemblyError } from './errors.js';
import { estimateContextUsage } from './contextUsage.js';
import type { AssembleContextInput, PreparedContext } from './types.js';

/**
 * Context 的唯一装配入口。
 *
 * 该函数没有时钟、数据库、模型调用或压缩副作用。同一份输入必然得到同一份
 * Provider 中立请求，因此 TurnExecution 可以在 Compact 前后安全地各调用一次。
 * Reminder 不属于这里：它在 Turn 开始时由 Turn 持久化，经有序 History 进入本函数。
 */
export function assembleContext(input: AssembleContextInput): PreparedContext {
  const history = stripCacheBreakpoints(input.history);
  const currentTurn = stripCacheBreakpoints(input.currentTurn);
  assertNoSystemMessages(history);
  assertNoSystemMessages(currentTurn);

  const prompt = buildPromptMessages(input.systemPrompt);
  const tools = projectToolPool(input.toolPool);
  const messages = markFinalCacheBreakpoint([
    ...prompt.messages,
    ...history,
    ...currentTurn,
  ]);
  const usage = estimateContextUsage({
    contextWindow: input.contextWindow,
    messages,
    tools,
    promptSections: prompt.sections,
    history,
    currentTurn,
  });

  return { messages, tools, usage };
}

interface PromptMessages {
  readonly messages: readonly Message[];
  readonly sections: readonly { readonly name: string; readonly message: Message }[];
}

function buildPromptMessages(systemPrompt: readonly string[]): PromptMessages {
  const boundaries = systemPrompt
    .map((section, index) => section === PROMPT_DYNAMIC_BOUNDARY ? index : -1)
    .filter((index) => index >= 0);
  if (boundaries.length === 0) {
    throw new ContextAssemblyError(
      'context/prompt-boundary-missing',
      'System Prompt 缺少动态边界哨兵。',
    );
  }
  if (boundaries.length > 1) {
    throw new ContextAssemblyError(
      'context/prompt-boundary-duplicated',
      'System Prompt 只能包含一个动态边界哨兵。',
    );
  }

  const boundary = boundaries[0]!;
  const staticSections = systemPrompt.slice(0, boundary).filter(hasContent);
  const dynamicSections = systemPrompt.slice(boundary + 1).filter(hasContent);
  if (staticSections.length === 0) {
    throw new ContextAssemblyError(
      'context/empty-static-prompt',
      'System Prompt 的稳定前缀不能为空。',
    );
  }

  const sections = [...staticSections, ...dynamicSections].map((content, index) => {
    const isLastStatic = index === staticSections.length - 1;
    const message: Message = {
      role: 'system',
      content,
      ...(isLastStatic ? { cacheBreakpoint: true as const } : {}),
    };
    return {
      name: promptSectionName(content, index),
      message,
    };
  });
  return {
    messages: sections.map((section) => section.message),
    sections,
  };
}

function markFinalCacheBreakpoint(messages: readonly Message[]): Message[] {
  const result = [...messages];
  for (let index = result.length - 1; index >= 0; index -= 1) {
    const message = result[index];
    if (!message || messageContentLength(message) === 0) continue;
    if (!message.cacheBreakpoint) result[index] = { ...message, cacheBreakpoint: true };
    break;
  }
  return result;
}

/** cacheBreakpoint 是单次请求投影，绝不能随工作历史进入下一次装配。 */
function stripCacheBreakpoints(messages: readonly Message[]): Message[] {
  return messages.map((message): Message => {
    if (!message.cacheBreakpoint) return message;
    if (message.role === 'system') return { role: 'system', content: message.content };
    if (message.role === 'user') return { role: 'user', content: message.content };
    return { role: 'assistant', content: message.content };
  });
}

function messageContentLength(message: Message): number {
  return typeof message.content === 'string' ? message.content.length : message.content.length;
}

function promptSectionName(content: string, index: number): string {
  const firstLine = content.split(/\r?\n/u).find((line) => line.trim().length > 0);
  const heading = firstLine?.replace(/^#{1,6}\s+/u, '').trim();
  return heading || `System Prompt ${index + 1}`;
}

function hasContent(value: string): boolean {
  return value.trim().length > 0;
}

function assertNoSystemMessages(messages: readonly Message[]): void {
  if (!messages.some((message) => message.role === 'system')) return;
  throw new ContextAssemblyError(
    'context/system-message-outside-prompt',
    'System message 只能来自 getSystemPrompt()，不能混入 History 或 Current Turn。',
  );
}

// ToolPool 是不同泛型 Tool 的统一擦除边界；模型投影只读取公共定义字段。
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyTool = Tool<any, any, any, any>;

function projectToolPool(toolPool: ToolPool): LlmTool[] {
  return toolPool.tools.map((tool: AnyTool): LlmTool => ({
    name: tool.name,
    description: tool.description,
    inputSchema: tool.inputJsonSchemaOverride
      ? { ...tool.inputJsonSchemaOverride }
      : toJSONSchema(tool.inputSchema) as Record<string, unknown>,
  }));
}
