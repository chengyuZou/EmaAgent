// 把 Ema 的统一 LLM 请求和 Anthropic Messages 流式协议相互转换。
import Anthropic from '@anthropic-ai/sdk';
import type { LlmAdapter } from './base.js';
import type {
  LlmRequest,
  LlmStreamChunk,
  Message,
  LlmToolDef,
  StopReason,
  ProviderConfig,
  AssistantBlock,
  LlmTokenUsage,
} from '../types.js';
import {
  ContextWindowExceededError,
  LlmStreamProtocolError,
  LlmToolArgumentsParseError,
  throwIfAborted,
  throwIfAbortError,
} from '../errors.js';
import { createLlmTokenUsage } from '../usage.js';
import type { ContentPart, ToolResultBlock, UserBlock } from '../message.js';

function createAnthropicUsage(
  uncachedInputTokens: number,
  outputTokens: number,
  cacheReadInputTokens: number | null | undefined,
  cacheWriteInputTokens: number | null | undefined,
): LlmTokenUsage {
  const inputTokens = uncachedInputTokens
    + (cacheReadInputTokens ?? 0)
    + (cacheWriteInputTokens ?? 0);
  return createLlmTokenUsage({
    inputTokens,
    outputTokens,
    cacheReadInputTokens,
    cacheWriteInputTokens,
    cacheEligibleInputTokens: inputTokens,
  });
}

function isContextWindowError(err: unknown): boolean {
  const msg = (err instanceof Error ? err.message : String(err)).toLowerCase();
  const status = (err as { status?: number }).status;
  return status === 400 && (
    msg.includes('prompt is too long') ||
    msg.includes('prompt_too_long') ||
    msg.includes('context window')
  );
}

// ── 辅助函数 ───────────────────────────────────────────────────────────────────

function mapStopReason(reason: string | null | undefined): StopReason {
  switch (reason) {
    case 'tool_use':      return 'tool_use';
    case 'max_tokens':    return 'max_tokens';
    case 'stop_sequence': return 'stop_sequence';
    default:              return 'end_turn';
  }
}

interface NormalizedMessages {
  system: Anthropic.MessageCreateParams['system'];
  messages: Anthropic.MessageParam[];
}

/**
 * 把 ContentPart（媒体）映射成 Anthropic content block param。
 * 不支持的类型(audio_data - Anthropic 无音频输入)返回 undefined。
 */
function mediaPartToAnthropicBlock(
  part: ContentPart,
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
      // Anthropic 不支持音频输入;调用方应先用 validateContentParts() 过滤。
      return undefined;
  }
}

/**
 * 把归一化 Message[] 转成 Anthropic 线路格式。
 *
 * 与旧扁平格式的关键差异:
 * 1. `system` 是顶层字段,非消息。
 * 2. assistant content 是有序 block 数组 - text + thinking + tool_use 交错。
 * 3. tool 结果已在 `role: 'user'` 消息内作为 ToolResultBlock[]。
 *    无需分组循环 - 归一化格式已匹配 Anthropic 要求。
 */
export function toAnthropicMessages(msgs: Message[]): NormalizedMessages {
  const systemBlocks: Anthropic.TextBlockParam[] = [];
  const messages: Anthropic.MessageParam[] = [];

  for (const msg of msgs) {
    if (msg.role === 'system') {
      systemBlocks.push({
        type: 'text',
        text: msg.content,
        ...(msg.cacheBreakpoint
          ? { cache_control: { type: 'ephemeral' as const } }
          : {}),
      });
      continue;
    }

    if (msg.role === 'user') {
      if (typeof msg.content === 'string') {
        // cacheBreakpoint:把字符串转 block,以便挂 cache_control。
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

      // UserBlock[] - 可能含媒体 part 和/或 ToolResultBlock 条目
      const content: Anthropic.ContentBlockParam[] = [];
      for (const block of msg.content as UserBlock[]) {
        if (block.type === 'tool_result') {
          const tb = block as ToolResultBlock;
          // Anthropic 的 ToolResultBlockParam.content 只接受 string 或
          // (TextBlockParam | ImageBlockParam)[] - 过滤后 cast。
          const resultContent: Anthropic.ToolResultBlockParam['content'] =
            typeof tb.content === 'string'
              ? tb.content
              : (tb.content as ContentPart[])
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
          const mapped = mediaPartToAnthropicBlock(block as ContentPart);
          if (mapped) content.push(mapped);
        }
      }
      // cacheBreakpoint:把 cache_control 扩展到最后一个 block。
      if (msg.cacheBreakpoint && content.length > 0) {
        const last = content.pop()!;
        content.push({ ...last, cache_control: { type: 'ephemeral' } } as Anthropic.ContentBlockParam);
      }
      messages.push({ role: 'user', content });
      continue;
    }

    // assistant - block 保留 text/thinking/tool_use 交错
    const content: Anthropic.ContentBlockParam[] = [];
    for (const block of msg.content as AssistantBlock[]) {
      if (block.type === 'text') {
        content.push({ type: 'text', text: block.text });
      } else if (block.type === 'thinking') {
        // 往返需要 Anthropic 原发的 signature。
        // 若缺失(如我们注入的),省略 - Anthropic 会重新生成 thinking。
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
    // assistant 消息上的 cacheBreakpoint。
    if (msg.cacheBreakpoint && content.length > 0) {
      const last = content.pop()!;
      content.push({ ...last, cache_control: { type: 'ephemeral' } } as Anthropic.ContentBlockParam);
    }
    messages.push({ role: 'assistant', content });
  }

  return {
    system: systemBlocks.length > 0 ? systemBlocks : undefined,
    messages,
  };
}

function toAnthropicToolChoice(
  tc: LlmRequest['toolChoice'],
): Anthropic.ToolChoiceAuto | Anthropic.ToolChoiceAny | Anthropic.ToolChoiceTool | undefined {
  if (tc === undefined) return undefined;
  if (tc === 'auto')    return { type: 'auto' };
  // Anthropic 无 'none' - 调用方应整体省略 tools;回退到 auto。
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

    const thinkingEnabled = request.thinking?.enabled === true;
    const streamBody: Anthropic.Messages.MessageStreamParams = {
      model:       modelName,
      messages,
      max_tokens:  request.maxTokens ?? 4096,
      temperature: thinkingEnabled ? 1 : request.temperature,
      ...(system    ? { system }                                          : {}),
      ...(tools?.length ? { tools, tool_choice: toolChoice }             : {}),
      ...(thinkingEnabled
        ? { thinking: { type: 'enabled' as const,
                        budget_tokens: (request.thinking as { budgetTokens?: number }).budgetTokens ?? 8000 } }
        : {}),
    };

    let anthropicStream: AsyncIterable<Anthropic.MessageStreamEvent>;
    try {
      anthropicStream = this.client.messages.stream(
        streamBody,
        {
          signal:  request.signal,
          headers: thinkingEnabled
            ? { 'anthropic-beta': 'interleaved-thinking-2025-05-14' }
            : undefined,
        },
      );
    } catch (err) {
      throwIfAbortError(err, request.signal);
      if (isContextWindowError(err)) {
        throw new ContextWindowExceededError(err instanceof Error ? err.message : String(err));
      }
      throw err;
    }

    // 以 Anthropic content_block index 为 key 跟踪进行中的 block。
    const toolBlocks = new Map<number, { id: string; name: string; argsJson: string }>();
    // 跟踪 Anthropic thinking signature。
    // Anthropic 通过 content_block_delta.signature_delta 流式传 signature,
    // 而非在 content_block_stop 上。
    const thinkingSignatures = new Map<number, string>();

    let uncachedInputTokens = 0;
    let outputTokens = 0;
    let cacheReadInputTokens: number | null | undefined;
    let cacheWriteInputTokens: number | null | undefined;
    let stopReason: StopReason = 'end_turn';
    let receivedMessageStop = false;

    try {
    for await (const event of anthropicStream) {
      switch (event.type) {
        case 'message_start':
          uncachedInputTokens = event.message.usage.input_tokens;
          cacheReadInputTokens = event.message.usage.cache_read_input_tokens;
          cacheWriteInputTokens = event.message.usage.cache_creation_input_tokens;
          yield {
            type: 'usage',
            ...createAnthropicUsage(
              uncachedInputTokens,
              outputTokens,
              cacheReadInputTokens,
              cacheWriteInputTokens,
            ),
          };
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
            let args: unknown;
            try {
              args = JSON.parse(block.argsJson);
            } catch (error) {
              throw new LlmToolArgumentsParseError(
                request.providerId,
                block.id,
                block.name,
                block.argsJson,
                error,
              );
            }
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
          yield {
            type: 'usage',
            ...createAnthropicUsage(
              uncachedInputTokens,
              outputTokens,
              cacheReadInputTokens,
              cacheWriteInputTokens,
            ),
          };
          break;

        case 'message_stop':
          receivedMessageStop = true;
          break;

        default:
          break;
      }
    }

    } catch (err) {
      throwIfAbortError(err, request.signal);
      if (isContextWindowError(err)) throw new ContextWindowExceededError(err instanceof Error ? err.message : String(err));
      throw err;
    }

    throwIfAborted(request.signal);
    if (!receivedMessageStop) throw new LlmStreamProtocolError(request.providerId);
    yield {
      type: 'usage',
      ...createAnthropicUsage(
        uncachedInputTokens,
        outputTokens,
        cacheReadInputTokens,
        cacheWriteInputTokens,
      ),
    };
    yield { type: 'done', stopReason };
  }
}
