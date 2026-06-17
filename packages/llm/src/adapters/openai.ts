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
import type { ToolResultBlock } from '@ema-agent/contracts';

// ── Helpers ───────────────────────────────────────────────────────────────────

type CompatThinkingParam = { type: 'enabled' | 'disabled' };

type OpenAiChatParamsWithCompatThinking =
  Omit<OpenAI.ChatCompletionCreateParamsStreaming, 'reasoning_effort'> & {
    /**
     * OpenAI-compatible providers can expose non-OpenAI thinking controls while
     * still using the Chat Completions wire format. DeepSeek accepts this field.
     */
    thinking?: CompatThinkingParam;
    /** DeepSeek accepts `max`; OpenAI's SDK type only includes OpenAI-native values. */
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
 * Convert normalized LlmMessage[] to OpenAI's ChatCompletion wire format.
 *
 * OpenAI still uses a flat protocol:
 * - assistant: { content: string | null, tool_calls: [...] }
 * - tool results: separate `role: 'tool'` messages (one per call)
 *
 * We unpack our block arrays back to the flat form here.
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

      // UserBlock[] — split into multimodal user message + individual tool messages.
      // ToolResultBlock entries become separate `role: 'tool'` messages (OpenAI protocol).
      // Non-tool blocks become one `role: 'user'` multimodal message.
      const mediaParts: OpenAI.ChatCompletionContentPart[] = [];

      for (const block of msg.content as UserBlock[]) {
        if (block.type === 'tool_result') {
          const tb = block as ToolResultBlock;
          // Tool result content: OpenAI only accepts strings here
          const content = typeof tb.content === 'string'
            ? tb.content
            : tb.content.map(p => (p.type === 'text' ? p.text : '[non-text content]')).join('\n');
          out.push({ role: 'tool', tool_call_id: tb.toolUseId, content });
          continue;
        }

        // Media part — map to OpenAI content part
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
          // file_data / file_url — OpenAI requires the Files API; skip silently
        }
      }

      if (mediaParts.length > 0) {
        out.push({ role: 'user', content: mediaParts });
      }
      continue;
    }

    // assistant — unpack blocks to flat OpenAI shape
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
      // thinking blocks have no OpenAI equivalent; skip silently
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
 * Handles both 'openai' and 'openai-compat' providers.
 * Pass baseURL to point at any OpenAI-compatible server (Ollama, LM Studio, …).
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

    const completion = await this.client.chat.completions.create(
      params as unknown as OpenAI.ChatCompletionCreateParamsStreaming,
      { signal: request.signal },
    );

    // Tool call buffers keyed by OpenAI's delta index.
    // OpenAI Chat Completions has no per-tool-call end event — only finish_reason marks
    // the end of all tool calls. We accumulate every tool's args here and flush all at
    // finish_reason time. This is slower than early-complete (tools only execute after
    // the full round-trip) but correct for both serial and parallel tool calls.
    const toolBufs = new Map<number, { id: string; name: string; argsJson: string }>();
    let stopReason: StopReason = 'end_turn';
    // Track whether reasoning_content ever arrived so text blockIndex stays consistent.
    let hasThinking = false;

    for await (const chunk of completion) {
      const choice = chunk.choices[0];
      const delta  = choice?.delta;

      // DeepSeek-reasoner (and compatible models) expose chain-of-thought in
      // `reasoning_content` — a non-standard field not in the OpenAI SDK types.
      const deltaAny = delta as Record<string, unknown> | undefined;
      if (typeof deltaAny?.reasoning_content === 'string' && deltaAny.reasoning_content) {
        hasThinking = true;
        yield { type: 'thinking_delta', blockIndex: 0, delta: deltaAny.reasoning_content };
      }

      if (delta?.content) {
        // If thinking arrived, text is blockIndex 1; otherwise it is blockIndex 0.
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

      // finish_reason — flush all tool buffers at once.
      // This is the only reliable completion boundary in Chat Completions streaming.
      if (choice?.finish_reason) {
        stopReason = mapStopReason(choice.finish_reason);
        for (const [idx, buf] of toolBufs) {
          let args: unknown;
          try {
            args = JSON.parse(buf.argsJson);
          } catch {
            // argsJson is not valid JSON — likely truncated by max_tokens or a provider bug.
            // Pass the raw fragment so the executor can surface a useful error to the model
            // rather than silently calling the tool with empty args.
            args = { __parse_error: true, raw: buf.argsJson.slice(0, 500) };
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
          inputTokens:  chunk.usage.prompt_tokens,
          outputTokens: chunk.usage.completion_tokens,
        };
      }
    }

    yield { type: 'done', stopReason };
  }
}
