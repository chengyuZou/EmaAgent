import { collectLLMCompletion } from './collectLLMCompletion.js';
import { throwIfAborted } from './errors.js';
import { assertProtocolInput } from './protocolInput.js';
import type {
  CallLLM,
  CompleteLLM,
  LLMConnection,
  LLMRequest,
  LLMStreamEvent,
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

/** 调用方只等待完整结果. SDK Client 在此闭包内复用, 每次请求的流和收集数据独立释放. */
export function createLLMCompletion(connection: LLMConnection, modelId: string): CompleteLLM {
  const callLLM = createLLMCall(connection, modelId);
  const protocol = connection.protocol;
  return async request => collectLLMCompletion(callLLM(request), protocol, request.signal);
}

