// 把 Ema 的统一 LLM 请求和 OpenAI Chat Completions 流式协议相互转换。
import OpenAI from 'openai';
import type { LlmAdapter } from './base.js';
import type {
  LlmRequest,
  LlmStreamChunk,
  LlmMessage,
  LlmContentPart,
  LlmToolDef,
  StopReason,
  ProviderConfig,
  AssistantBlock,
  UserBlock,
} from '../types.js';
import {
  ContextWindowExceededError,
  LlmToolArgumentsParseError,
  throwIfAborted,
  throwIfAbortError,
} from '../errors.js';
import { createLlmTokenUsage } from '../usage.js';
import type { ToolResultBlock } from '@ema-agent/contracts';

function isContextWindowError(err: unknown): boolean {
  const msg = (err instanceof Error ? err.message : String(err)).toLowerCase();
  const status = (err as { status?: number }).status;
  return status === 400 && (
    msg.includes('maximum context length') ||
    msg.includes('context_length_exceeded') ||
    msg.includes('context window')
  );
}

// ── 辅助函数 ───────────────────────────────────────────────────────────────────

type CompatThinkingParam = { type: 'enabled' | 'disabled' };

type OpenAiChatParamsWithCompatThinking =
  Omit<OpenAI.ChatCompletionCreateParamsStreaming, 'reasoning_effort'> & {
    /**
     * OpenAI 兼容 provider 可在仍使用 Chat Completions 线路格式的情况下,
     * 暴露非 OpenAI 的 thinking 控制。DeepSeek 接受此字段。
     */
    thinking?: CompatThinkingParam;
    /** DeepSeek 接受 `max`;OpenAI SDK 类型只含 OpenAI 原生值。 */
    reasoning_effort?: 'high' | 'max';
  };

function mapStopReason(reason: string | null | undefined): StopReason {
  switch (reason) {
    case 'tool_calls':      return 'tool_use';
    case 'length':          return 'max_tokens';
    case 'content_filter':  return 'stop_sequence';
    default:                return 'end_turn';
  }
}

function applyCompatThinkingParams(
  params: OpenAiChatParamsWithCompatThinking,
  thinking: LlmRequest['thinking'],
): void {
  if (!thinking) return;

  if (thinking.enabled !== 'auto') {
    params.thinking = { type: thinking.enabled ? 'enabled' : 'disabled' };
  }

  if (thinking.enabled !== false && thinking.effort) {
    params.reasoning_effort = thinking.effort;
  }
}

/**
 * 把归一化 LlmMessage[] 转成 OpenAI ChatCompletion 线路格式。
 *
 * OpenAI 仍用扁平协议:
 * - assistant:{ content: string | null, tool_calls: [...] }
 * - tool 结果:单独的 `role: 'tool'` 消息(每个 call 一条)
 *
 * 在此把我们的 block 数组拆回扁平形式。
 */
function toOpenAiMessages(messages: LlmMessage[]): OpenAI.ChatCompletionMessageParam[] {
  const out: OpenAI.ChatCompletionMessageParam[] = [];

  for (const msg of messages) {
    if (msg.role === 'system') {
      out.push({ role: 'system', content: msg.content });
      continue;
    }

    if (msg.role === 'user') {
      if (typeof msg.content === 'string') {
        out.push({ role: 'user', content: msg.content });
        continue;
      }

      // UserBlock[] - 拆成多模态 user 消息 + 各条 tool 消息。
      // ToolResultBlock 条目变成单独的 `role: 'tool'` 消息(OpenAI 协议)。
      // 非 tool block 变成一条 `role: 'user'` 多模态消息。
      const mediaParts: OpenAI.ChatCompletionContentPart[] = [];

      for (const block of msg.content as UserBlock[]) {
        if (block.type === 'tool_result') {
          const tb = block as ToolResultBlock;
          // tool 结果内容:OpenAI 此处只接受字符串
          const content = typeof tb.content === 'string'
            ? tb.content
            : tb.content.map(p => (p.type === 'text' ? p.text : '[non-text content]')).join('\n');
          out.push({ role: 'tool', tool_call_id: tb.toolUseId, content });
          continue;
        }

        // 媒体 part - 映射到 OpenAI content part
        const part = block as LlmContentPart;
        switch (part.type) {
          case 'text':
            mediaParts.push({ type: 'text', text: part.text });
            break;
          case 'image_url':
            mediaParts.push({ type: 'image_url', image_url: { url: part.url } });
            break;
          case 'image_data':
            mediaParts.push({ type: 'image_url', image_url: { url: `data:${part.mimeType};base64,${part.data}` } });
            break;
          case 'audio_data': {
            const fmt = part.mimeType === 'audio/wav'  ? 'wav'
                      : part.mimeType === 'audio/mpeg' || part.mimeType === 'audio/mp3' ? 'mp3'
                      : null;
            if (fmt) {
              mediaParts.push({ type: 'input_audio', input_audio: { data: part.data, format: fmt } } as OpenAI.ChatCompletionContentPart);
            }
            break;
          }
          // file_data / file_url - OpenAI 需 Files API;静默跳过
        }
      }

      if (mediaParts.length > 0) {
        out.push({ role: 'user', content: mediaParts });
      }
      continue;
    }

    // assistant - 把 block 拆成扁平 OpenAI 形状
    let textContent = '';
    const toolCalls: OpenAI.ChatCompletionMessageToolCall[] = [];

    for (const block of msg.content as AssistantBlock[]) {
      if (block.type === 'text') {
        textContent += block.text;
      } else if (block.type === 'tool_use') {
        toolCalls.push({
          id:       block.id,
          type:     'function',
          function: { name: block.name, arguments: JSON.stringify(block.args) },
        });
      }
      // thinking block 无 OpenAI 等价物;静默跳过
    }

    out.push({
      role:       'assistant',
      content:    textContent || null,
      tool_calls: toolCalls.length ? toolCalls : undefined,
    });
  }

  return out;
}

function toOpenAiTool(tool: LlmToolDef): OpenAI.ChatCompletionTool {
  return {
    type: 'function',
    function: {
      name:        tool.name,
      description: tool.description,
      parameters:  tool.parameters,
    },
  };
}

function toOpenAiToolChoice(
  tc: LlmRequest['toolChoice'],
): OpenAI.ChatCompletionToolChoiceOption | undefined {
  if (tc === undefined) return undefined;
  if (tc === 'auto')    return 'auto';
  if (tc === 'none')    return 'none';
  return { type: 'function', function: { name: tc.name } };
}

// ── Adapter ───────────────────────────────────────────────────────────────────

/**
 * 同时处理 'openai' 与 'openai-compat' provider。
 * 传 baseURL 指向任意 OpenAI 兼容服务器(Ollama、LM Studio 等)。
 */
export class OpenAiAdapter implements LlmAdapter {
  private readonly client: OpenAI;

  constructor(config: ProviderConfig) {
    this.client = new OpenAI({ apiKey: config.apiKey, baseURL: config.baseUrl });
  }

  async *stream(request: LlmRequest, modelName: string): AsyncIterable<LlmStreamChunk> {
    const messages = toOpenAiMessages(request.messages);
    const tools    = request.tools?.map(toOpenAiTool);

    const params: OpenAiChatParamsWithCompatThinking = {
      model:          modelName,
      messages,
      tools:          tools?.length ? tools : undefined,
      tool_choice:    tools?.length ? toOpenAiToolChoice(request.toolChoice) : undefined,
      max_tokens:     request.maxTokens,
      temperature:    request.temperature,
      stream:         true,
      stream_options: { include_usage: true },
    };
    applyCompatThinkingParams(params, request.thinking);

    let completion: AsyncIterable<OpenAI.ChatCompletionChunk>;
    try {
      completion = await this.client.chat.completions.create(
        params as unknown as OpenAI.ChatCompletionCreateParamsStreaming,
        { signal: request.signal },
      );
    } catch (err) {
      throwIfAbortError(err, request.signal);
      if (isContextWindowError(err)) {
        throw new ContextWindowExceededError(err instanceof Error ? err.message : String(err));
      }
      throw err;
    }

    // 以 OpenAI delta index 为 key 的 tool call 缓冲。
    // OpenAI Chat Completions 没有 per-tool-call 结束事件 - 只有 finish_reason 标记
    // 所有 tool call 的结束。在此累计每个 tool 的 args,在 finish_reason 时一次性 flush。
    // 比早完成慢(tools 只在全往返后执行),但对串行和并行 tool call 都正确。
    const toolBufs = new Map<number, { id: string; name: string; argsJson: string }>();
    let stopReason: StopReason = 'end_turn';
    // 从 catalog 预初始化,这样即使 reasoning_content 在首个 text chunk 之后到达
    // (DeepSeek-reasoner 真实顺序),blockIndex 也保持稳定。
    let hasThinking = request.supportsReasoning ?? false;

    try {
    for await (const chunk of completion) {
      const choice = chunk.choices[0];
      const delta  = choice?.delta;

      // DeepSeek-reasoner(及兼容模型)在 `reasoning_content` 里暴露思维链 -
      // 一个 OpenAI SDK 类型里没有的非标准字段。
      const deltaAny = delta as Record<string, unknown> | undefined;
      if (typeof deltaAny?.reasoning_content === 'string' && deltaAny.reasoning_content) {
        hasThinking = true;
        yield { type: 'thinking_delta', blockIndex: 0, delta: deltaAny.reasoning_content };
      }

      if (delta?.content) {
        // 若已出现 thinking,text 是 blockIndex 1;否则 blockIndex 0。
        yield { type: 'text_delta', blockIndex: hasThinking ? 1 : 0, delta: delta.content };
      }

      if (delta?.tool_calls) {
        for (const tc of delta.tool_calls) {
          const idx = tc.index;

          if (!toolBufs.has(idx)) {
            toolBufs.set(idx, { id: '', name: '', argsJson: '' });
          }
          const buf = toolBufs.get(idx)!;
          if (tc.id)                  buf.id       = tc.id;
          if (tc.function?.name)      buf.name      = tc.function.name;
          if (tc.function?.arguments) {
            buf.argsJson += tc.function.arguments;
            yield {
              type:       'tool_use_delta',
              blockIndex: 1000 + idx,
              callId:     buf.id,
              name:       buf.name,
              argsDelta:  tc.function.arguments,
            };
          }
        }
      }

      // finish_reason - 一次性 flush 所有 tool 缓冲。
      // 这是 Chat Completions 流式里唯一可靠的完成边界。
      if (choice?.finish_reason) {
        stopReason = mapStopReason(choice.finish_reason);
        for (const [idx, buf] of toolBufs) {
          let args: unknown;
          try {
            args = JSON.parse(buf.argsJson);
          } catch (error) {
            throw new LlmToolArgumentsParseError(
              request.providerId,
              buf.id,
              buf.name,
              buf.argsJson,
              error,
            );
          }
          yield {
            type:       'tool_use_complete',
            blockIndex: 1000 + idx,
            callId:     buf.id,
            name:       buf.name,
            args,
          };
        }
        toolBufs.clear();
      }

      if (chunk.usage) {
        yield {
          type:         'usage',
          ...createLlmTokenUsage({
            inputTokens: chunk.usage.prompt_tokens,
            outputTokens: chunk.usage.completion_tokens,
            cacheReadInputTokens: chunk.usage.prompt_tokens_details?.cached_tokens,
          }),
        };
      }
    }

    } catch (err) {
      throwIfAbortError(err, request.signal);
      if (isContextWindowError(err)) throw new ContextWindowExceededError(err instanceof Error ? err.message : String(err));
      throw err;
    }

    throwIfAborted(request.signal);
    yield { type: 'done', stopReason };
  }
}
