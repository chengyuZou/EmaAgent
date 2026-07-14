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
import { ContextWindowExceededError } from '../types.js';
import type { ToolResultBlock, MessageContentPart } from '@ema-agent/contracts';

function isContextWindowError(err: unknown): boolean {
  const msg = (err instanceof Error ? err.message : String(err)).toLowerCase();
  const status = (err as { status?: number }).status;
  return status === 400 && (
    msg.includes('maximum context length') ||
    msg.includes('context_length_exceeded') ||
    msg.includes('context window')
  );
}

// ── 类型(从 openai SDK 命名空间收窄) ────────────────────────────────────────

type ResponseInput     = OpenAI.Responses.ResponseInput;
type ResponseInputItem = OpenAI.Responses.ResponseInputItem;
type FunctionTool      = OpenAI.Responses.FunctionTool;
type ToolChoiceOptions = OpenAI.Responses.ToolChoiceOptions;
type ToolChoiceFunction= OpenAI.Responses.ToolChoiceFunction;
type ResponseStreamEvent = OpenAI.Responses.ResponseStreamEvent;

// ── 消息转换 ────────────────────────────────────────────────────────────────

/**
 * 把单个 MessageContentPart 映射成 Responses API input content item。
 * 不支持的类型(audio)返回 null。
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
      // 若匹配模式则当作 OpenAI Files API file_id,
      // 否则作为 file_data URL 传。
      return {
        type:    'input_file',
        file_id: part.url,
      };
    case 'audio_data':
      // Responses API 普通消息不支持音频输入。
      // 调用方应先用 validateContentParts() 过滤。
      return null;
  }
}

/**
 * 把归一化 LlmMessage[] 转成 Responses API input 格式。
 *
 * 与 Chat Completions 的关键差异:
 * 1. `system` 消息 -> `instructions` 字符串参数(多条用 \n\n 合并)。
 * 2. `assistant` tool_use block -> input 数组里单独的 `function_call` item。
 * 3. `user` tool_result block -> 单独的 `function_call_output` item。
 * 4. assistant 历史里的 thinking block 静默丢弃 - 模型会在需要时重新生成推理。
 *    (与 Anthropic 不同,无需往返。)
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
          // tool 结果在 Responses API input 里是顶层 item。
          // 与其他内容混在一起时,必须先于下一条 user 消息。
          // 先 flush 已缓冲的 content part,以保留顺序。
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
      // thinking block:静默跳过 - Responses API 无往返
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

// ── 工具转换 ───────────────────────────────────────────────────────────────────

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
 * OpenAI Responses API adapter(/v1/responses)。
 *
 * 相对 Chat Completions(`openai-llm`)的优势:
 * - `response.function_call_arguments.done` 提供可靠的 per-tool 结束事件,
 *   无需等 finish_reason 即可早发 tool_use_complete。
 * - o-series 推理通过 `response.reasoning_summary_text.delta` 暴露。
 * - 原生支持并行 tool call,无 delta 交错问题。
 *
 * OpenAI 原生模型用此协议(`openai-responses-llm`)。
 * 任意 OpenAI 兼容第三方 provider(DeepSeek、SiliconFlow、Ollama、LM Studio 等)
 * 用 `openai-llm`(Chat Completions)。
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

    // 跨事件跟踪状态。
    let stopReason: StopReason = 'end_turn';
    let hasReasoning           = false;
    let toolBlockCount         = 0;

    // output_index -> { name, blockIndex } - 在 output_item.added 时填,
    // 在 arguments.delta / arguments.done 到达时消费(它们带 output_index)。
    const toolMeta = new Map<number, { name: string; callId: string; blockIndex: number }>();

    try {
      for await (const event of responseStream) {
        switch (event.type) {

          // ── 推理摘要(o-series) ─────────────────────────────────
          case 'response.reasoning_summary_text.delta': {
            hasReasoning = true;
            yield { type: 'thinking_delta', blockIndex: 0, delta: event.delta };
            break;
          }

          // ── Text ──────────────────────────────────────────────────────────
          case 'response.output_text.delta': {
            // 无推理时 blockIndex 0;推理先于 text 时 blockIndex 1。
            yield {
              type:       'text_delta',
              blockIndex: hasReasoning ? 1 : 0,
              delta:      event.delta,
            };
            break;
          }

          // ── Function call 开始 - 捕获 name + 分配 blockIndex ──────
          case 'response.output_item.added': {
            const item = event.item;
            if (item.type === 'function_call') {
              const blockIndex = 1000 + toolBlockCount++;
              // `call_id` 是把 arguments.delta/done 绑到本 call 的稳定 ID。
              // `id` 是内部 item ID。用 `call_id` 作为我们的 `callId`。
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

          // ── Function call args 完成 - 早发 tool_use_complete ─────────
          case 'response.function_call_arguments.done': {
            const meta = toolMeta.get(event.output_index);
            if (meta) {
              let args: unknown = {};
              try { args = JSON.parse(event.arguments); } catch { /* 保持 {} */ }
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

          // ── Response 完成 - usage ─────────────────────────────────────
          case 'response.completed': {
            const usage = event.response.usage;
            if (usage) {
              yield {
                type:         'usage',
                inputTokens:  usage.input_tokens,
                outputTokens: usage.output_tokens,
              };
            }
            // 若尚未是 tool_use,把 incomplete_details 映射到 stop reason。
            if (stopReason === 'end_turn') {
              const reason = event.response.incomplete_details?.reason;
              if (reason === 'max_output_tokens') stopReason = 'max_tokens';
              else if (reason === 'content_filter') stopReason = 'stop_sequence';
            }
            break;
          }

          // ── 错误事件 ───────────────────────────────────────────────────
          case 'response.failed':
          case 'response.incomplete': {
            // 作为 stop_sequence 上报,让 engine 知道这不是干净结束。
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
      if (isContextWindowError(err)) throw new ContextWindowExceededError(err instanceof Error ? err.message : String(err));
      throw err;
    }

    yield { type: 'done', stopReason };
  }
}
