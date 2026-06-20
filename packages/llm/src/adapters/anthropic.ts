import Anthropic from '@anthropic-ai/sdk';
import type { LlmAdapter } from './base.js';
import type {
  LlmRequest,
  LlmStreamChunk,
  LlmMessage,
  LlmToolDef,
  StopReason,
  ProviderConfig,
  AssistantBlock,
} from '../types.js';
import type { UserBlock, ToolResultBlock, MessageContentPart } from '@ema-agent/contracts';

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
 * Map a MessageContentPart (media) to an Anthropic content block param.
 * Returns undefined for unsupported types (audio_data — Anthropic has no audio input).
 */
function mediaPartToAnthropicBlock(
  part: MessageContentPart,
): Anthropic.ContentBlockParam | undefined {
  switch (part.type) {
    case 'text':
      return { type: 'text', text: part.text };
    case 'image_url':
      return { type: 'image', source: { type: 'url', url: part.url } satisfies Anthropic.URLImageSource };
    case 'image_data':
      return {
        type:   'image',
        source: {
          type:       'base64',
          media_type: part.mimeType as Anthropic.Base64ImageSource['media_type'],
          data:       part.data,
        },
      };
    case 'file_data':
      return {
        type:   'document',
        source: {
          type:       'base64',
          media_type: part.mimeType as 'application/pdf' | 'text/plain',
          data:       part.data,
        },
      } as Anthropic.ContentBlockParam;
    case 'file_url':
      return {
        type:   'document',
        source: { type: 'url', url: part.url },
      } as Anthropic.ContentBlockParam;
    case 'audio_data':
      // Anthropic does not support audio input; callers should use validateContentParts() first.
      return undefined;
  }
}

/**
 * Convert our normalized LlmMessage[] to Anthropic's wire format.
 *
 * Key differences from the old flat format:
 * 1. `system` is a top-level field, not a message.
 * 2. assistant content is an ordered block array — text + thinking + tool_use interleaved.
 * 3. tool results are already inside `role: 'user'` messages as ToolResultBlock[].
 *    No grouping loop needed — the normalized format already matches Anthropic's requirements.
 */
function toAnthropicMessages(msgs: LlmMessage[]): NormalizedMessages {
  let system: string | undefined;
  const messages: Anthropic.MessageParam[] = [];

  for (const msg of msgs) {
    if (msg.role === 'system') {
      system = msg.content;
      continue;
    }

    if (msg.role === 'user') {
      if (typeof msg.content === 'string') {
        // cacheBreakpoint: convert string to block so we can attach cache_control.
        if (msg.cacheBreakpoint) {
          messages.push({
            role:    'user',
            content: [{ type: 'text', text: msg.content, cache_control: { type: 'ephemeral' } }],
          });
        } else {
          messages.push({ role: 'user', content: msg.content });
        }
        continue;
      }

      // UserBlock[] — may contain media parts and/or ToolResultBlock entries
      const content: Anthropic.ContentBlockParam[] = [];
      for (const block of msg.content as UserBlock[]) {
        if (block.type === 'tool_result') {
          const tb = block as ToolResultBlock;
          // Anthropic's ToolResultBlockParam.content only accepts string or
          // (TextBlockParam | ImageBlockParam)[] — cast after filtering.
          const resultContent: Anthropic.ToolResultBlockParam['content'] =
            typeof tb.content === 'string'
              ? tb.content
              : (tb.content as MessageContentPart[])
                  .map(mediaPartToAnthropicBlock)
                  .filter((b): b is Anthropic.ContentBlockParam => b !== undefined) as
                  (Anthropic.TextBlockParam | Anthropic.ImageBlockParam)[];
          content.push({
            type:        'tool_result',
            tool_use_id: tb.toolUseId,
            content:     resultContent,
            is_error:    tb.isError,
          });
        } else {
          const mapped = mediaPartToAnthropicBlock(block as MessageContentPart);
          if (mapped) content.push(mapped);
        }
      }
      // cacheBreakpoint: spread cache_control onto the last block.
      if (msg.cacheBreakpoint && content.length > 0) {
        const last = content.pop()!;
        content.push({ ...last, cache_control: { type: 'ephemeral' } } as Anthropic.ContentBlockParam);
      }
      messages.push({ role: 'user', content });
      continue;
    }

    // assistant — blocks preserve text/thinking/tool_use interleaving
    const content: Anthropic.ContentBlockParam[] = [];
    for (const block of msg.content as AssistantBlock[]) {
      if (block.type === 'text') {
        content.push({ type: 'text', text: block.text });
      } else if (block.type === 'thinking') {
        // Round-trip requires the original signature Anthropic issued.
        // If missing (e.g. injected by us), omit — Anthropic will re-generate thinking.
        if (block.signature) {
          content.push({
            type:      'thinking',
            thinking:  block.thinking,
            signature: block.signature,
          } as Anthropic.ContentBlockParam);
        }
      } else if (block.type === 'tool_use') {
        content.push({
          type:  'tool_use',
          id:    block.id,
          name:  block.name,
          input: block.args as Record<string, unknown>,
        });
      }
    }
    // cacheBreakpoint on assistant messages.
    if (msg.cacheBreakpoint && content.length > 0) {
      const last = content.pop()!;
      content.push({ ...last, cache_control: { type: 'ephemeral' } } as Anthropic.ContentBlockParam);
    }
    messages.push({ role: 'assistant', content });
  }

  return { system, messages };
}

function toAnthropicToolChoice(
  tc: LlmRequest['toolChoice'],
): Anthropic.ToolChoiceAuto | Anthropic.ToolChoiceAny | Anthropic.ToolChoiceTool | undefined {
  if (tc === undefined) return undefined;
  if (tc === 'auto')    return { type: 'auto' };
  // Anthropic has no 'none' — caller should omit tools entirely; fall back to auto.
  if (tc === 'none')    return { type: 'auto' };
  return { type: 'tool', name: tc.name };
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
    const tools      = request.toolChoice === 'none' ? undefined : request.tools?.map(toAnthropicTool);
    const toolChoice = tools?.length ? toAnthropicToolChoice(request.toolChoice) : undefined;

    const anthropicStream = this.client.messages.stream(
      {
        model:        modelName,
        system,
        messages,
        tools:        tools?.length ? tools : undefined,
        tool_choice:  toolChoice,
        max_tokens:   request.maxTokens ?? 4096,
        temperature:  request.temperature,
      },
      { signal: request.signal },
    );

    // Track in-progress blocks keyed by Anthropic content_block index.
    const toolBlocks = new Map<number, { id: string; name: string; argsJson: string }>();
    // Track Anthropic thinking signatures.
    // Anthropic streams signature via content_block_delta.signature_delta,
    // not on content_block_stop.
    const thinkingSignatures = new Map<number, string>();

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
              id:       event.content_block.id,
              name:     event.content_block.name,
              argsJson: '',
            });
          } else if (event.content_block.type === 'thinking') {
            thinkingSignatures.set(event.index, '');
          }
          break;

        case 'content_block_delta':
          if (event.delta.type === 'text_delta') {
            yield { type: 'text_delta', blockIndex: event.index, delta: event.delta.text };
          } else if (event.delta.type === 'thinking_delta') {
            yield { type: 'thinking_delta', blockIndex: event.index, delta: event.delta.thinking };
          } else if (event.delta.type === 'signature_delta') {
            const prev = thinkingSignatures.get(event.index) ?? '';
            thinkingSignatures.set(event.index, prev + event.delta.signature);
          } else if (event.delta.type === 'input_json_delta') {
            const block = toolBlocks.get(event.index);
            if (block) {
              block.argsJson += event.delta.partial_json;
              yield {
                type:      'tool_use_delta',
                blockIndex: event.index,
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
            yield {
              type:       'tool_use_complete',
              blockIndex: event.index,
              callId:     block.id,
              name:       block.name,
              args,
            };
            toolBlocks.delete(event.index);
          }
          if (thinkingSignatures.has(event.index)) {
            const signature = thinkingSignatures.get(event.index)!;
            yield {
              type: 'thinking_complete',
              blockIndex: event.index,
              signature: signature,
            };
          }
          thinkingSignatures.delete(event.index);
          break;
        }

        case 'message_delta':
          outputTokens = event.usage.output_tokens;
          stopReason   = mapStopReason(event.delta.stop_reason);
          break;

        default:
          break;
      }
    }

    yield { type: 'usage', inputTokens, outputTokens };
    yield { type: 'done', stopReason };
  }
}
