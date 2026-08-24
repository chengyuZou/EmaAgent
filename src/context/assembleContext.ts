// 组装一次 LLM Call 的 Provider 中立输入；是否压缩由调用方在本函数之外决定。
import type { LlmTool, Message } from '@ema-agent/llm';
import type { PromptBlock } from '@ema-agent/prompts';
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
  const composed = [
    ...prompt.messages,
    ...history,
    ...currentTurn,
  ];
  // 断点布局（Anthropic 上限 4，这里用 3）：静态 Prompt 段末尾（buildPromptMessages
  // 已标记）；历史/当前 Turn 边界——主请求习惯性写下 [system+history] 缓存块，
  // 自动 Compact 的摘要请求、同 Turn 后续 Call 与下一 Turn 的历史前缀都读它；
  // 全文最后一个非空消息（markFinalCacheBreakpoint）。
  if (history.length > 0) {
    const boundaryIndex = prompt.messages.length + history.length - 1;
    const target = composed[boundaryIndex]!;
    if (!target.cacheBreakpoint) {
      composed[boundaryIndex] = { ...target, cacheBreakpoint: true };
    }
  }
  const messages = markFinalCacheBreakpoint(composed);
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

/**
 * PromptBlock → system 消息的直接投影：数组顺序即发送顺序；cacheBreakpoint
 * 只来自块自身标记（最后一个产品静态块），不再有哨兵切分。空内容块不进请求。
 */
function buildPromptMessages(systemPrompt: readonly PromptBlock[]): PromptMessages {
  const blocks = systemPrompt.filter(block => block.content.trim().length > 0);
  if (blocks.length === 0) {
    throw new ContextAssemblyError(
      'context/empty-system-prompt',
      'System Prompt 不能为空。',
    );
  }

  const sections = blocks.map(block => ({
    name: block.name,
    message: {
      role: 'system' as const,
      content: block.content,
      ...(block.cacheBreakpoint ? { cacheBreakpoint: true as const } : {}),
    },
  }));
  return {
    messages: sections.map(section => section.message),
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
    // generatedBy 是中立执行元数据，必须随工作历史保留到下一次 Adapter 裁决。
    return {
      role: 'assistant',
      content: message.content,
      ...(message.generatedBy ? { generatedBy: message.generatedBy } : {}),
    };
  });
}

function messageContentLength(message: Message): number {
  return typeof message.content === 'string' ? message.content.length : message.content.length;
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
