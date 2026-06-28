import OpenAI from 'openai';
import type { LlmAdapter } from './base.js';
import type {
  LlmRequest,
  LlmStreamChunk,
  LlmMessage,
  LlmToolDef,
  StopReason,
  ProviderConfig,
  AssistantBlock,
  UserBlock,
} from '../types.js';
import type { ToolResultBlock, MessageContentPart } from '@ema-agent/contracts';

// ── Types (narrowed from openai SDK namespace) ────────────────────────────────

type ResponseInput     = OpenAI.Responses.ResponseInput;
type ResponseInputItem = OpenAI.Responses.ResponseInputItem;
type FunctionTool      = OpenAI.Responses.FunctionTool;
type ToolChoiceOptions = OpenAI.Responses.ToolChoiceOptions;
type ToolChoiceFunction= OpenAI.Responses.ToolChoiceFunction;
type ResponseStreamEvent = OpenAI.Responses.ResponseStreamEvent;

// ── Message conversion ────────────────────────────────────────────────────────

/**
 * Map a single MessageContentPart to a Responses API input content item.
 * Returns null for unsupported types (audio).
 */
function mediaPartToResponsesContent(
  part: MessageContentPart,
): OpenAI.Responses.ResponseInputContent | null {
  switch (part.type) {
    case 'text':
      return { type: 'input_text', text: part.text };
    case 'image_url':
      return { type: 'input_image', detail: 'auto', image_url: part.url };
    case 'image_data':
      return {
        type:      'input_image',
        detail:    'auto',
        image_url: `data:${part.mimeType};base64,${part.data}`,
      };
    case 'file_data':
      return {
        type:      'input_file',
        file_data: `data:${part.mimeType};base64,${part.data}`,
        filename:  part.filename,
      };
    case 'file_url':
      // Treat as an OpenAI Files API file_id if it matches the pattern,
      // otherwise pass as file_data URL.
      return {
        type:    'input_file',
        file_id: part.url,
      };
    case 'audio_data':
      // Responses API does not support audio input in regular messages.
      // Caller should use validateContentParts() to screen this out first.
      return null;
  }
}

/**
 * Convert our normalized LlmMessage[] to the Responses API input format.
 *
 * Key differences from Chat Completions:
 * 1. `system` message → `instructions` string param (multiple merged with \n\n).
 * 2. `assistant` tool_use blocks → separate `function_call` items in the input array.
 * 3. `user` tool_result blocks → separate `function_call_output` items.
 * 4. Thinking blocks in assistant history are silently dropped — the model will
 *    re-generate reasoning if needed. (No round-trip needed unlike Anthropic.)
 */
function toResponsesInput(
  msgs: LlmMessage[],
): { instructions: string | undefined; input: ResponseInput } {
  const input: ResponseInputItem[] = [];
  let instructions: string | undefined;

  for (const msg of msgs) {

    // ── System ──────────────────────────────────────────────────────────────
    if (msg.role === 'system') {
      instructions = instructions
        ? `${instructions}\n\n${msg.content}`
        : msg.content;
      continue;
    }

    // ── User ─────────────────────────────────────────────────────────────────
    if (msg.role === 'user') {
      if (typeof msg.content === 'string') {
        input.push({ role: 'user', content: msg.content });
        continue;
      }

      const contentParts: OpenAI.Responses.ResponseInputContent[] = [];

      for (const block of msg.content as UserBlock[]) {
        if (block.type === 'tool_result') {
          const tb = block as ToolResultBlock;
          // Tool results are top-level items in the Responses API input.
          // They must precede the next user message when mixed together.
          // Flush any buffered content parts first so ordering is preserved.
          if (contentParts.length > 0) {
            input.push({ role: 'user', content: [...contentParts] });
            contentParts.length = 0;
          }
          const output =
            typeof tb.content === 'string'
              ? tb.content
              : tb.content.map(p => (p.type === 'text' ? p.text : '[non-text]')).join('\n');
          input.push({
            type:     'function_call_output',
            call_id:  tb.toolUseId,
            output,
          } as OpenAI.Responses.ResponseInputItem.FunctionCallOutput);
        } else {
          const mapped = mediaPartToResponsesContent(block as MessageContentPart);
          if (mapped) contentParts.push(mapped);
        }
      }

      if (contentParts.length > 0) {
        input.push({ role: 'user', content: contentParts });
      }
      continue;
    }

    // ── Assistant ─────────────────────────────────────────────────────────────
    let assistantText = '';
    const toolCalls: OpenAI.Responses.ResponseFunctionToolCall[] = [];

    for (const block of msg.content as AssistantBlock[]) {
      if (block.type === 'text') {
        assistantText += block.text;
      } else if (block.type === 'tool_use') {
        toolCalls.push({
          type:      'function_call',
          id:        block.id,
          call_id:   block.id,
          name:      block.name,
          arguments: JSON.stringify(block.args),
        });
      }
      // thinking blocks: silently skip — no round-trip in Responses API
    }

    if (assistantText) {
      input.push({ role: 'assistant', content: assistantText });
    }
    for (const tc of toolCalls) {
      input.push(tc as ResponseInputItem);
    }
  }

  return { instructions, input };
}

// ── Tool conversion ───────────────────────────────────────────────────────────

function toResponsesTool(tool: LlmToolDef): FunctionTool {
  return {
    type:        'function',
    name:        tool.name,
    description: tool.description ?? null,
    parameters:  tool.parameters as Record<string, unknown>,
    strict:      true,
  };
}

function toResponsesToolChoice(
  tc: LlmRequest['toolChoice'],
): ToolChoiceOptions | ToolChoiceFunction | undefined {
  if (tc === undefined) return undefined;
  if (tc === 'auto')    return 'auto';
  if (tc === 'none')    return 'none';
  return { type: 'function', name: tc.name };
}

// ── Adapter ───────────────────────────────────────────────────────────────────

/**
 * OpenAI Responses API adapter (/v1/responses).
 *
 * Advantages over Chat Completions (`openai-llm`):
 * - `response.function_call_arguments.done` provides a reliable per-tool end
 *   event, enabling early tool_use_complete without waiting for finish_reason.
 * - o-series reasoning is exposed via `response.reasoning_summary_text.delta`.
 * - Parallel tool calls are natively supported without delta interleaving issues.
 *
 * Use this protocol (`openai-responses-llm`) for OpenAI native models.
 * Use `openai-llm` (Chat Completions) for any OpenAI-compatible third-party
 * provider (DeepSeek, SiliconFlow, Ollama, LM Studio, etc.).
 */
export class OpenAiResponsesAdapter implements LlmAdapter {
  private readonly client: OpenAI;

  constructor(config: ProviderConfig) {
    this.client = new OpenAI({ apiKey: config.apiKey, baseURL: config.baseUrl });
  }

  async *stream(request: LlmRequest, modelName: string): AsyncIterable<LlmStreamChunk> {
    const { instructions, input } = toResponsesInput(request.messages);

    const params: OpenAI.Responses.ResponseCreateParamsStreaming = {
      model:             modelName,
      input,
      stream:            true,
      max_output_tokens: request.maxTokens,
      temperature:       request.temperature,
    };

    if (instructions) params.instructions = instructions;
    if (request.tools?.length && request.toolChoice !== 'none') {
      params.tools = request.tools.map(toResponsesTool);
      params.tool_choice = toResponsesToolChoice(request.toolChoice) as
        OpenAI.Responses.ResponseCreateParamsStreaming['tool_choice'];
    }

    if (request.thinking?.enabled !== false && (request.thinking as { effort?: string } | undefined)?.effort) {
      const effort = (request.thinking as { effort: string }).effort;
      params.reasoning = { effort: effort as 'low' | 'medium' | 'high' };
    }

    let responseStream: AsyncIterable<ResponseStreamEvent>;
    try {
      responseStream = await this.client.responses.create(params, {
        signal: request.signal,
      });
    } catch (err) {
      if (request.signal?.aborted) {
        yield { type: 'done', stopReason: 'end_turn' };
        return;
      }
      throw err;
    }

    // Track state across events.
    let stopReason: StopReason = 'end_turn';
    let hasReasoning           = false;
    let toolBlockCount         = 0;

    // output_index → { name, blockIndex } — populated on output_item.added,
    // consumed when arguments.delta / arguments.done arrive (they carry output_index).
    const toolMeta = new Map<number, { name: string; callId: string; blockIndex: number }>();

    try {
      for await (const event of responseStream) {
        switch (event.type) {

          // ── Reasoning summary (o-series) ─────────────────────────────────
          case 'response.reasoning_summary_text.delta': {
            hasReasoning = true;
            yield { type: 'thinking_delta', blockIndex: 0, delta: event.delta };
            break;
          }

          // ── Text ──────────────────────────────────────────────────────────
          case 'response.output_text.delta': {
            // blockIndex 0 when no reasoning; 1 when reasoning preceded text.
            yield {
              type:       'text_delta',
              blockIndex: hasReasoning ? 1 : 0,
              delta:      event.delta,
            };
            break;
          }

          // ── Function call started — capture name + assign blockIndex ──────
          case 'response.output_item.added': {
            const item = event.item;
            if (item.type === 'function_call') {
              const blockIndex = 1000 + toolBlockCount++;
              // `call_id` is the stable ID that ties arguments.delta/done to this call.
              // `id` is the internal item ID. Use `call_id` as our `callId`.
              toolMeta.set(event.output_index, {
                name:       item.name,
                callId:     item.call_id,
                blockIndex,
              });
            }
            break;
          }

          // ── Function call args delta ──────────────────────────────────────
          case 'response.function_call_arguments.delta': {
            const meta = toolMeta.get(event.output_index);
            if (meta) {
              yield {
                type:       'tool_use_delta',
                blockIndex: meta.blockIndex,
                callId:     meta.callId,
                name:       meta.name,
                argsDelta:  event.delta,
              };
            }
            break;
          }

          // ── Function call args complete — EARLY tool_use_complete ─────────
          case 'response.function_call_arguments.done': {
            const meta = toolMeta.get(event.output_index);
            if (meta) {
              let args: unknown = {};
              try { args = JSON.parse(event.arguments); } catch { /* keep {} */ }
              yield {
                type:       'tool_use_complete',
                blockIndex: meta.blockIndex,
                callId:     meta.callId,
                name:       meta.name,
                args,
              };
              stopReason = 'tool_use';
              toolMeta.delete(event.output_index);
            }
            break;
          }

          // ── Response completed — usage ─────────────────────────────────────
          case 'response.completed': {
            const usage = event.response.usage;
            if (usage) {
              yield {
                type:         'usage',
                inputTokens:  usage.input_tokens,
                outputTokens: usage.output_tokens,
              };
            }
            // Map incomplete_details to stop reason if not already tool_use.
            if (stopReason === 'end_turn') {
              const reason = event.response.incomplete_details?.reason;
              if (reason === 'max_output_tokens') stopReason = 'max_tokens';
              else if (reason === 'content_filter') stopReason = 'stop_sequence';
            }
            break;
          }

          // ── Error event ───────────────────────────────────────────────────
          case 'response.failed':
          case 'response.incomplete': {
            // Surface as stop_sequence so the engine knows this wasn't a clean end.
            if (stopReason === 'end_turn') stopReason = 'stop_sequence';
            break;
          }

          default:
            break;
        }
      }
    } catch (err) {
      if (request.signal?.aborted) {
        yield { type: 'done', stopReason };
        return;
      }
      throw err;
    }

    yield { type: 'done', stopReason };
  }
}
