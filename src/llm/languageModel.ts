// 创建点冻结连接与模型身份的语言模型调用入口；stream 是唯一执行线，
// createLlmCompletion 是同一条流的无损收集器（要一把拿结果的消费方自行调用）。
import type { AssistantBlock } from './message.js';
import { assertProtocolInput } from './protocolInput.js';
import { createAnthropicProtocol } from './protocols/anthropic.js';
import { createGeminiProtocol } from './protocols/gemini.js';
import { createOpenAiChatProtocol } from './protocols/openAiChat.js';
import { createOpenAiResponsesProtocol } from './protocols/openAiResponses.js';
import type {
  CallLlm,
  LlmCompletion,
  LlmConnection,
  LlmRequest,
  LlmStreamEvent,
  LlmThinkingState,
  LlmTokenUsage,
} from './types.js';
import { updateLlmCallUsage } from './usage.js';

/** LLM 唯一创建入口；连接与 modelId 在创建时冻结并复用 SDK Client。 */
export function createLlmCall(connection: LlmConnection, modelId: string): CallLlm {
  if (!modelId.trim()) throw new TypeError('LLM model must not be empty');
  const protocolStream = createProtocolStream(connection, modelId);
  return (request: LlmRequest): AsyncIterable<LlmStreamEvent> => {
    assertProtocolInput(connection.protocol, request.messages);
    return protocolStream(request);
  };
}

function createProtocolStream(
  connection: LlmConnection,
  modelId: string,
): CallLlm {
  switch (connection.protocol) {
    case 'openai-llm':
      return createOpenAiChatProtocol(connection, modelId);
    case 'openai-responses-llm':
      return createOpenAiResponsesProtocol(connection, modelId);
    case 'anthropic-llm':
      return createAnthropicProtocol(connection, modelId);
    case 'gemini-llm':
      return createGeminiProtocol(connection, modelId);
  }
}

/**
 * 把流式 thinking 文本与协议原生状态合成可重放的 Assistant Block。
 * OpenAI reasoning 的摘要文本可缺省，但 item id/encryptedContent 本身仍必须保留；
 * Anthropic 与 Gemini 没有思考文本时不制造空内容块。
 */
export function createAssistantThinkingBlock(
  thinking: string | undefined,
  state: LlmThinkingState | undefined,
): AssistantBlock | undefined {
  if (state?.kind === 'openai') {
    return {
      type: 'reasoning',
      id: state.id,
      ...(thinking ? { summaryText: thinking } : {}),
      ...(state.encryptedContent ? { encryptedContent: state.encryptedContent } : {}),
    };
  }
  if (thinking === undefined) return undefined;
  if (state?.kind === 'gemini') {
    return {
      type: 'gemini_thought',
      text: thinking,
      ...(state.thoughtSignature ? { thoughtSignature: state.thoughtSignature } : {}),
    };
  }
  return {
    type: 'thinking',
    thinking,
    ...(state?.kind === 'anthropic' && state.signature
      ? { signature: state.signature }
      : {}),
  };
}

/** 对一条 stream 的无损收集：块按原始 blockIndex 顺序聚合，usage 取末次快照差，stopReason 来自 done。 */
export async function createLlmCompletion(
  stream: AsyncIterable<LlmStreamEvent>,
): Promise<LlmCompletion> {
  const blocks = new Map<number, AssistantBlock>();
  let usage: LlmTokenUsage = { inputTokens: 0, outputTokens: 0 };
  let stopReason: LlmCompletion['stopReason'] = 'end_turn';

  for await (const event of stream) {
    switch (event.type) {
      case 'text_delta': {
        const current = blocks.get(event.blockIndex);
        const text = current?.type === 'text' ? current.text : '';
        blocks.set(event.blockIndex, { type: 'text', text: text + event.delta });
        break;
      }
      case 'thinking_delta': {
        const current = blocks.get(event.blockIndex);
        const thinking = current?.type === 'thinking' ? current.thinking : '';
        blocks.set(event.blockIndex, { type: 'thinking', thinking: thinking + event.delta });
        break;
      }
      case 'thinking_complete': {
        const current = blocks.get(event.blockIndex);
        const block = createAssistantThinkingBlock(
          current?.type === 'thinking' ? current.thinking : undefined,
          event.state,
        );
        if (block) blocks.set(event.blockIndex, block);
        break;
      }
      case 'tool_use_delta':
        break;
      case 'tool_use_complete':
        blocks.set(event.blockIndex, {
          type: 'tool_use',
          id: event.callId,
          name: event.name,
          args: event.args,
        });
        break;
      case 'usage':
        usage = updateLlmCallUsage(usage, event).usage;
        break;
      case 'done':
        stopReason = event.stopReason;
        break;
    }
  }

  return {
    blocks: [...blocks.entries()]
      .sort(([left], [right]) => left - right)
      .map(([, block]) => block),
    stopReason,
    usage,
  };
}
