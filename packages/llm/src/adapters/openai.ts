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

function mapStopReason(reason: string | null | undefined): StopReason {
  switch (reason) {
    case 'tool_calls':      return 'tool_use';
    case 'length':          return 'max_tokens';
    case 'content_filter':  return 'stop_sequence';
    default:                return 'end_turn';
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

    const completion = await this.client.chat.completions.create(
      {
        model:          modelName,
        messages,
        tools:          tools?.length ? tools : undefined,
        tool_choice:    tools?.length ? toOpenAiToolChoice(request.toolChoice) : undefined,
        max_tokens:     request.maxTokens,
        temperature:    request.temperature,
        stream:         true,
        stream_options: { include_usage: true },
      },
      { signal: request.signal },
    );

    // Tool call buffers keyed by OpenAI's delta index (not the same as blockIndex).
    // blockIndex for tool calls = TEXT_BLOCK_COUNT + tool_delta_index, approximated as:
    // we use a synthetic blockIndex = 1000 + tc.index so text (index 0) always sorts before tools.
    const toolBufs = new Map<number, { id: string; name: string; argsJson: string }>();
    let stopReason: StopReason = 'end_turn';
    let lastToolIndex = -1;

    for await (const chunk of completion) {
      const choice = chunk.choices[0];
      const delta  = choice?.delta;

      // DeepSeek-reasoner (and compatible models) expose chain-of-thought in
      // `reasoning_content` — a non-standard field not in the OpenAI SDK types.
      // blockIndex 0 = thinking, blockIndex 1 = final text, so they sort correctly.
      const deltaAny = delta as Record<string, unknown> | undefined;
      if (typeof deltaAny?.reasoning_content === 'string' && deltaAny.reasoning_content) {
        yield { type: 'thinking_delta', blockIndex: 0, delta: deltaAny.reasoning_content };
      }

      if (delta?.content) {
        // Text lives at blockIndex 1 so it always sorts after any thinking (blockIndex 0).
        yield { type: 'text_delta', blockIndex: 1, delta: delta.content };
      }

      if (delta?.tool_calls) {
        for (const tc of delta.tool_calls) {
          const idx = tc.index;

          // Index jump: OpenAI moved to a new tool. The previous tool at (idx-1) is complete.
          // Emit tool_use_complete early so the engine can stream-execute it.
          if (idx > lastToolIndex && lastToolIndex >= 0) {
            const prevBuf = toolBufs.get(lastToolIndex);
            if (prevBuf) {
              let args: unknown = {};
              try { args = JSON.parse(prevBuf.argsJson); } catch { /* keep {} */ }
              yield {
                type:       'tool_use_complete',
                blockIndex: 1000 + lastToolIndex,
                callId:     prevBuf.id,
                name:       prevBuf.name,
                args,
              };
              toolBufs.delete(lastToolIndex);
            }
          }
          lastToolIndex = Math.max(lastToolIndex, idx);

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

      // finish_reason — flush any remaining tool buffers
      if (choice?.finish_reason) {
        stopReason = mapStopReason(choice.finish_reason);
        for (const [idx, buf] of toolBufs) {
          let args: unknown = {};
          try { args = JSON.parse(buf.argsJson); } catch { /* keep {} */ }
          yield {
            type:       'tool_use_complete',
            blockIndex: 1000 + idx,
            callId:     buf.id,
            name:       buf.name,
            args,
          };
        }
        toolBufs.clear();
        lastToolIndex = -1;
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
