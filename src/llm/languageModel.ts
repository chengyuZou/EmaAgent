// 创建一个绑定协议连接的语言模型入口，并从同一条流收集非流式结果。
import type { AssistantBlock } from './message.js';
import { assertProtocolInput } from './protocolInput.js';
import { createAnthropicProtocol } from './protocols/anthropic.js';
import { createGeminiProtocol } from './protocols/gemini.js';
import { createOpenAiChatProtocol } from './protocols/openAiChat.js';
import { createOpenAiResponsesProtocol } from './protocols/openAiResponses.js';
import type {
  LlmCompletion,
  LlmConnection,
  LlmRequest,
  LlmStreamEvent,
  LlmTokenUsage,
} from './types.js';
import { advanceLlmUsageSnapshot } from './usage.js';

export interface LanguageModel {
  readonly protocol: LlmConnection['protocol'];
  stream(request: LlmRequest): AsyncIterable<LlmStreamEvent>;
  complete(request: LlmRequest): Promise<LlmCompletion>;
}

/**
 * LLM 唯一创建入口。连接在创建时冻结并复用 SDK Client；请求只携带每次调用变化的数据。
 */
export function createLanguageModel(connection: LlmConnection): LanguageModel {
  const protocolStream = createProtocolStream(connection);
  const stream = (request: LlmRequest): AsyncIterable<LlmStreamEvent> => {
    assertProtocolInput(connection.protocol, request.messages);
    return protocolStream(request);
  };
  return {
    protocol: connection.protocol,
    stream,
    complete: (request) => collectCompletion(stream(request)),
  };
}

function createProtocolStream(
  connection: LlmConnection,
): (request: LlmRequest) => AsyncIterable<LlmStreamEvent> {
  switch (connection.protocol) {
    case 'openai-llm':
      return createOpenAiChatProtocol(connection);
    case 'openai-responses-llm':
      return createOpenAiResponsesProtocol(connection);
    case 'anthropic-llm':
      return createAnthropicProtocol(connection);
    case 'gemini-llm':
      return createGeminiProtocol(connection);
  }
}

async function collectCompletion(
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
        blocks.set(event.blockIndex, {
          type: 'thinking',
          thinking: current?.type === 'thinking' ? current.thinking : '',
          ...(event.signature ? { signature: event.signature } : {}),
        });
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
        usage = advanceLlmUsageSnapshot(usage, event).snapshot;
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
