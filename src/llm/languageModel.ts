import { throwIfAborted } from './errors.js';
import type { AssistantBlock } from './message.js';
import { assertProtocolInput } from './protocolInput.js';
import type {
  CallLLM,
  CompleteLLM,
  LLMConnection,
  LLMRequest,
  LLMStreamEvent,
  LLMThinkingState,
} from './types.js';

/** 连接与 modelId 在创建时固定, 同一 CallLLM 的请求复用 SDK Client. */
export function createLLMCall(connection: LLMConnection, modelId: string): CallLLM {
  if (!modelId.trim()) throw new TypeError('LLM model must not be empty');
  const callConnection: LLMConnection = { ...connection };
  // 共享初始化 Promise, 避免并发的首次请求各自创建客户端.
  let protocolStream: Promise<CallLLM> | undefined;
  async function* stream(request: LLMRequest): AsyncIterable<LLMStreamEvent> {
    throwIfAborted(request.signal);
    protocolStream ??= createProtocolStream(callConnection, modelId);
    const call = await protocolStream;
    throwIfAborted(request.signal);
    yield* call(request);
  }

  return (request: LLMRequest): AsyncIterable<LLMStreamEvent> => {
    assertProtocolInput(callConnection.protocol, request.messages);
    return stream(request);
  };
}

async function createProtocolStream(
  connection: LLMConnection,
  modelId: string,
): Promise<CallLLM> {
  // 只加载实际使用的协议, 避免启动时加载全部 SDK. 同一调用函数复用初始化结果.
  switch (connection.protocol) {
    case 'openai-llm': {
      const { createOpenAiChatProtocol } = await import('./protocols/openAiChat.js');
      return createOpenAiChatProtocol(connection, modelId);
    }
    case 'openai-responses-llm': {
      const { createOpenAiResponsesProtocol } = await import('./protocols/openAiResponses.js');
      return createOpenAiResponsesProtocol(connection, modelId);
    }
    case 'anthropic-llm': {
      const { createAnthropicProtocol } = await import('./protocols/anthropic.js');
      return createAnthropicProtocol(connection, modelId);
    }
    case 'gemini-llm': {
      const { createGeminiProtocol } = await import('./protocols/gemini.js');
      return createGeminiProtocol(connection, modelId);
    }
  }
}

/** 与流式入口使用相同的连接固定和延迟初始化规则, 通过 SDK 非流式请求取得完整结果. */
export function createLLMCompletion(connection: LLMConnection, modelId: string): CompleteLLM {
  if (!modelId.trim()) throw new TypeError('LLM model must not be empty');
  const callConnection: LLMConnection = { ...connection };
  let protocolCompletion: Promise<CompleteLLM> | undefined;

  return async (request) => {
    throwIfAborted(request.signal);
    assertProtocolInput(callConnection.protocol, request.messages);
    protocolCompletion ??= createProtocolCompletion(callConnection, modelId);
    const complete = await protocolCompletion;
    throwIfAborted(request.signal);
    return complete(request);
  };
}

async function createProtocolCompletion(
  connection: LLMConnection,
  modelId: string,
): Promise<CompleteLLM> {
  switch (connection.protocol) {
    case 'openai-llm': {
      const { createOpenAiChatCompletion } = await import('./protocols/openAiChat.js');
      return createOpenAiChatCompletion(connection, modelId);
    }
    case 'openai-responses-llm': {
      const { createOpenAiResponsesCompletion } = await import('./protocols/openAiResponses.js');
      return createOpenAiResponsesCompletion(connection, modelId);
    }
    case 'anthropic-llm': {
      const { createAnthropicCompletion } = await import('./protocols/anthropic.js');
      return createAnthropicCompletion(connection, modelId);
    }
    case 'gemini-llm': {
      const { createGeminiCompletion } = await import('./protocols/gemini.js');
      return createGeminiCompletion(connection, modelId);
    }
  }
}

/**
 * 将思考文本和原生状态合成历史消息中的内容块.
 * OpenAI 可以只返回 reasoning ID 而没有摘要文本, 此时仍保留原生状态.
 * Anthropic 和 Gemini 没有思考文本时不创建空内容块.
 */
export function createAssistantThinkingBlock(
  thinking: string | undefined,
  state: LLMThinkingState | undefined,
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

