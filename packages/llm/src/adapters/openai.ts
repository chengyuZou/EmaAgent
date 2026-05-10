import OpenAI from 'openai';
import type { LlmAdapter } from './base.js';
import type {
  LlmRequest,
  LlmStreamChunk,
  LlmMessage,
  LlmToolDef,
  LlmToolCall,
  StopReason,
} from '../types.js';

// ── Helpers ───────────────────────────────────────────────────────────────────

function mapStopReason(reason: string | null | undefined): StopReason {
  switch (reason) {
    case 'tool_calls':      return 'tool_use';
    case 'length':          return 'max_tokens';
    case 'content_filter':  return 'stop_sequence';
    default:                return 'end_turn';
  }
}

function toOpenAiMessages(messages: LlmMessage[]): OpenAI.ChatCompletionMessageParam[] {
  return messages.map((msg): OpenAI.ChatCompletionMessageParam => {
    if (msg.role === 'system') {
      return { role: 'system', content: msg.content };
    }
    if (msg.role === 'user') {
      return { role: 'user', content: msg.content };
    }
    if (msg.role === 'tool') {
      return { role: 'tool', tool_call_id: msg.toolCallId, content: msg.content };
    }
    // assistant
    const toolCalls: OpenAI.ChatCompletionMessageToolCall[] | undefined =
      msg.toolCalls?.map((tc: LlmToolCall) => ({
        id:       tc.id,
        type:     'function' as const,
        function: { name: tc.name, arguments: JSON.stringify(tc.args) },
      }));
    return { role: 'assistant', content: msg.content ?? null, tool_calls: toolCalls };
  });
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

// ── Adapter ───────────────────────────────────────────────────────────────────

/**
 * Handles both 'openai' and 'openai-compat' providers.
 * Pass baseURL to point at any OpenAI-compatible server (Ollama, LM Studio, …).
 */
export class OpenAiAdapter implements LlmAdapter {
  private readonly client: OpenAI;

  constructor(apiKey: string, baseURL?: string) {
    this.client = new OpenAI({ apiKey, baseURL });
  }

  async *stream(request: LlmRequest, modelName: string): AsyncIterable<LlmStreamChunk> {
    const messages = toOpenAiMessages(request.messages);
    const tools    = request.tools?.map(toOpenAiTool);

    const completion = await this.client.chat.completions.create(
      {
        model:          modelName,
        messages,
        tools:          tools?.length ? tools : undefined,
        max_tokens:     request.maxTokens,
        temperature:    request.temperature,
        stream:         true,
        // Append usage as the very last SSE chunk instead of inside the stream body.
        stream_options: { include_usage: true },
      },
      { signal: request.signal },
    );

    // Tool call args arrive in pieces across many chunks, keyed by index.
    const toolBufs = new Map<number, { id: string; name: string; argsJson: string }>();
    let stopReason: StopReason = 'end_turn';

    for await (const chunk of completion) {
      const choice = chunk.choices[0];
      const delta  = choice?.delta;

      // ── Text delta ──────────────────────────────────────────────────────────
      if (delta?.content) {
        yield { type: 'text_delta', delta: delta.content };
      }

      // ── Tool call args streaming ─────────────────────────────────────────
      if (delta?.tool_calls) {
        for (const tc of delta.tool_calls) {
          const idx = tc.index;
          if (!toolBufs.has(idx)) {
            toolBufs.set(idx, { id: '', name: '', argsJson: '' });
          }
          const buf = toolBufs.get(idx)!;
          if (tc.id)                buf.id       = tc.id;
          if (tc.function?.name)    buf.name      = tc.function.name;
          if (tc.function?.arguments) {
            buf.argsJson += tc.function.arguments;
            yield {
              type:      'tool_use_delta',
              callId:    buf.id,
              name:      buf.name,
              argsDelta: tc.function.arguments,
            };
          }
        }
      }

      // ── finish_reason — emit completed tool calls ────────────────────────
      if (choice?.finish_reason) {
        stopReason = mapStopReason(choice.finish_reason);
        for (const buf of toolBufs.values()) {
          let args: unknown = {};
          try { args = JSON.parse(buf.argsJson); } catch { /* keep {} on malformed */ }
          yield { type: 'tool_use_complete', callId: buf.id, name: buf.name, args };
        }
        toolBufs.clear();
      }

      // ── Usage (final chunk when include_usage: true) ─────────────────────
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
