import Anthropic from '@anthropic-ai/sdk';
import type { LlmAdapter } from './base.js';
import type {
  LlmRequest,
  LlmStreamChunk,
  LlmMessage,
  LlmToolDef,
  StopReason,
  ProviderConfig,
} from '../types.js';

// ── Helpers ───────────────────────────────────────────────────────────────────

function mapStopReason(reason: string | null | undefined): StopReason {
  switch (reason) {
    case 'tool_use':      return 'tool_use';
    case 'max_tokens':    return 'max_tokens';
    case 'stop_sequence': return 'stop_sequence';
    default:              return 'end_turn';
  }
}

interface NormalizedMessages {
  system: string | undefined;
  messages: Anthropic.MessageParam[];
}

/**
 * Anthropic differences from our normalized format:
 * 1. `system` is a top-level field, not a message.
 * 2. assistant messages are content arrays (text + tool_use blocks).
 * 3. tool results must be grouped into one user turn per assistant turn.
 */
function toAnthropicMessages(msgs: LlmMessage[]): NormalizedMessages {
  let system: string | undefined;
  const messages: Anthropic.MessageParam[] = [];

  for (let i = 0; i < msgs.length; i++) {
    const msg = msgs[i]!;

    if (msg.role === 'system') {
      system = msg.content;
      continue;
    }

    if (msg.role === 'user') {
      if (typeof msg.content === 'string') {
        messages.push({ role: 'user', content: msg.content });
      } else {
        // Multimodal: map LlmContentPart[] → Anthropic content block array
        // SDK types:
        //   ImageBlockParam = { type: 'image', source: Base64ImageSource | URLImageSource }
        //   Base64ImageSource = { type: 'base64', media_type: '...', data: string }
        //   URLImageSource    = { type: 'url', url: string }
        //
        // Unsupported types (audio_data) are silently skipped.
        // Call validateContentParts() before startTurn() to surface these to the user.
        const content: Anthropic.ContentBlockParam[] = [];
        for (const part of msg.content) {
          if (part.type === 'text') {
            content.push({ type: 'text', text: part.text });
            continue;
          }
          if (part.type === 'image_url') {
            content.push({
              type:   'image',
              source: { type: 'url', url: part.url } satisfies Anthropic.URLImageSource,
            } satisfies Anthropic.ImageBlockParam);
            continue;
          }
          if (part.type === 'image_data') {
            content.push({
              type:   'image',
              source: {
                type:       'base64',
                media_type: part.mimeType as Anthropic.Base64ImageSource['media_type'],
                data:       part.data,
              },
            } satisfies Anthropic.ImageBlockParam);
            continue;
          }
          if (part.type === 'file_data') {
            // Anthropic document block — supports PDF and plain text
            content.push({
              type:   'document',
              source: {
                type:       'base64',
                media_type: part.mimeType as 'application/pdf' | 'text/plain',
                data:       part.data,
              },
            } as Anthropic.ContentBlockParam);
            continue;
          }
          if (part.type === 'file_url') {
            content.push({
              type:   'document',
              source: { type: 'url', url: part.url },
            } as Anthropic.ContentBlockParam);
            continue;
          }
          // audio_data — Anthropic does not support audio input; skip silently
        }
        messages.push({ role: 'user', content });
      }
      continue;
    }

    if (msg.role === 'assistant') {
      const content: Anthropic.ContentBlockParam[] = [];
      if (msg.content) {
        content.push({ type: 'text', text: msg.content });
      }
      for (const tc of msg.toolCalls ?? []) {
        content.push({
          type:  'tool_use',
          id:    tc.id,
          name:  tc.name,
          input: tc.args as Record<string, unknown>,
        });
      }
      messages.push({ role: 'assistant', content });
      continue;
    }

    if (msg.role === 'tool') {
      // Consecutive tool messages → one user turn with multiple tool_result blocks.
      // Anthropic requires all results from the same assistant turn to be batched.
      const results: Anthropic.ToolResultBlockParam[] = [];
      while (i < msgs.length && msgs[i]!.role === 'tool') {
        const toolMsg = msgs[i] as Extract<LlmMessage, { role: 'tool' }>;
        results.push({ type: 'tool_result', tool_use_id: toolMsg.toolCallId, content: toolMsg.content });
        i++;
      }
      i--; // outer for-loop will increment
      messages.push({ role: 'user', content: results });
    }
  }

  return { system, messages };
}

function toAnthropicTool(tool: LlmToolDef): Anthropic.Tool {
  return {
    name:         tool.name,
    description:  tool.description,
    input_schema: { type: 'object', ...tool.parameters } as Anthropic.Tool['input_schema'],
  };
}

// ── Adapter ───────────────────────────────────────────────────────────────────

export class AnthropicAdapter implements LlmAdapter {
  private readonly client: Anthropic;

  constructor(config: ProviderConfig) {
    this.client = new Anthropic({ apiKey: config.apiKey, baseURL: config.baseUrl });
  }

  async *stream(request: LlmRequest, modelName: string): AsyncIterable<LlmStreamChunk> {
    const { system, messages } = toAnthropicMessages(request.messages);
    const tools = request.tools?.map(toAnthropicTool);

    // The second argument to .stream() is RequestOptions — this is where signal goes.
    const anthropicStream = this.client.messages.stream(
      {
        model:       modelName,
        system,
        messages,
        tools:       tools?.length ? tools : undefined,
        max_tokens:  request.maxTokens ?? 4096,
        temperature: request.temperature,
      },
      { signal: request.signal },
    );

    // Track in-progress tool-use blocks by content block index.
    const toolBlocks = new Map<number, { id: string; name: string; argsJson: string }>();
    let inputTokens  = 0;
    let outputTokens = 0;
    let stopReason: StopReason = 'end_turn';

    for await (const event of anthropicStream) {
      switch (event.type) {
        case 'message_start':
          inputTokens = event.message.usage.input_tokens;
          break;

        case 'content_block_start':
          if (event.content_block.type === 'tool_use') {
            toolBlocks.set(event.index, {
              id:      event.content_block.id,
              name:    event.content_block.name,
              argsJson: '',
            });
          }
          break;

        case 'content_block_delta':
          if (event.delta.type === 'text_delta') {
            yield { type: 'text_delta', delta: event.delta.text };
          } else if (event.delta.type === 'input_json_delta') {
            const block = toolBlocks.get(event.index);
            if (block) {
              block.argsJson += event.delta.partial_json;
              yield {
                type:      'tool_use_delta',
                callId:    block.id,
                name:      block.name,
                argsDelta: event.delta.partial_json,
              };
            }
          }
          break;

        case 'content_block_stop': {
          const block = toolBlocks.get(event.index);
          if (block) {
            let args: unknown = {};
            try { args = JSON.parse(block.argsJson); } catch { /* keep {} */ }
            yield { type: 'tool_use_complete', callId: block.id, name: block.name, args };
            toolBlocks.delete(event.index);
          }
          break;
        }

        case 'message_delta':
          outputTokens = event.usage.output_tokens;
          stopReason   = mapStopReason(event.delta.stop_reason);
          break;

        // 'ping', 'message_stop' — nothing to do
        default:
          break;
      }
    }

    yield { type: 'usage', inputTokens, outputTokens };
    yield { type: 'done', stopReason };
  }
}
