// Session Message → LLM 历史的唯一转换入口：把持久化消息投影为 Provider 中立历史，
// 只保留完整配对的 Tool 配对；thinking 作为协议原生推理状态保留并携带生成来源
// （generatedBy），重放/删除由目标协议 Adapter 裁决。每条产出携带来源 Session
// Message id，供 Macro 摘要成功后映射 summarizedThroughMessageId（不进入 Compact 或 LLM 请求）。
import type {
  AssistantBlock,
  ContentPart,
  LlmGenerationSource,
  Message as ModelMessage,
  ToolResultContentPart,
  UserBlock,
} from '@ema-agent/llm';
import type { Message as SessionMessage } from '@ema-agent/session';

export interface LlmHistoryMessage {
  readonly sessionMessageId: string;
  readonly message: ModelMessage;
}

/**
 * Session 中的 system 不是模型历史：System Prompt 每次重新生成，把它重放会
 * 制造重复事实。空块与未配对 tool_use/tool_result 被丢弃；thinking 保留为
 * 原生推理状态并 attach 所属 Turn 的生成来源。产出数组可能比输入短，
 * 身份映射只允许使用 sessionMessageId，不可用下标对齐输入。
 */
export function deriveLlmHistory(
  history: readonly SessionMessage[],
  resolveGenerationTarget: (turnId: string) => LlmGenerationSource | undefined,
): LlmHistoryMessage[] {
  const messages: LlmHistoryMessage[] = [];
  const pairedToolIds = collectPairedToolIds(history);

  for (const message of history) {
    if (message.role === 'system') continue;

    if (message.role === 'user') {
      if (typeof message.blocks === 'string') {
        if (message.blocks.trim()) {
          messages.push({
            sessionMessageId: message.id,
            message: { role: 'user', content: message.blocks },
          });
        }
        continue;
      }
      if (Array.isArray(message.blocks)) {
        const content = message.blocks
          .map((block) => projectUserBlock(block, pairedToolIds))
          .filter((part): part is UserBlock => part !== undefined);
        if (content.length > 0) {
          messages.push({
            sessionMessageId: message.id,
            message: { role: 'user', content },
          });
        }
      }
      continue;
    }

    if (Array.isArray(message.blocks)) {
      const content = message.blocks
        .map((block) => projectAssistantBlock(block, pairedToolIds))
        .filter((block): block is AssistantBlock => block !== undefined);
      if (content.length > 0) {
        const generatedBy = message.turnId
          ? resolveGenerationTarget(message.turnId)
          : undefined;
        messages.push({
          sessionMessageId: message.id,
          message: {
            role: 'assistant',
            content,
            ...(generatedBy ? { generatedBy } : {}),
          },
        });
      }
    }
  }

  return messages;
}

function projectAssistantBlock(
  block: unknown,
  pairedToolIds: ReadonlySet<string>,
): AssistantBlock | undefined {
  if (!block || typeof block !== 'object') return undefined;
  const candidate = block as {
    type?: unknown;
    text?: unknown;
    thinking?: unknown;
    id?: unknown;
    name?: unknown;
    args?: unknown;
  };
  if (candidate.type === 'text' && typeof candidate.text === 'string' && candidate.text.trim()) {
    return { type: 'text', text: candidate.text };
  }
  // thinking 保留为协议原生推理状态；是否重放由目标协议 Adapter 依据 generatedBy 裁决。
  if (
    candidate.type === 'thinking'
    && typeof candidate.thinking === 'string'
    && candidate.thinking.trim()
  ) {
    const signature = (block as { signature?: unknown }).signature;
    return {
      type: 'thinking',
      thinking: candidate.thinking,
      ...(typeof signature === 'string' && signature.length > 0 ? { signature } : {}),
    };
  }
  // 只有完整配对的 tool_use 才能进入下一次请求。
  if (
    candidate.type === 'tool_use'
    && typeof candidate.id === 'string'
    && typeof candidate.name === 'string'
    && pairedToolIds.has(candidate.id)
  ) {
    return {
      type: 'tool_use',
      id: candidate.id,
      name: candidate.name,
      args: candidate.args,
    };
  }
  return undefined;
}

function projectUserBlock(
  block: unknown,
  pairedToolIds: ReadonlySet<string>,
): UserBlock | undefined {
  if (block && typeof block === 'object') {
    const candidate = block as {
      type?: unknown;
      toolCallId?: unknown;
      content?: unknown;
      isError?: unknown;
    };
    if (candidate.type === 'tool_result') {
      if (typeof candidate.toolCallId !== 'string' || !pairedToolIds.has(candidate.toolCallId)) {
        return undefined;
      }
      const content = typeof candidate.content === 'string'
        ? candidate.content
        : Array.isArray(candidate.content)
          ? candidate.content
              .map(projectToolResultPart)
              .filter((part): part is ToolResultContentPart => part !== undefined)
          : undefined;
      if (content === undefined) return undefined;
      return {
        type: 'tool_result',
        toolCallId: candidate.toolCallId,
        content,
        ...(typeof candidate.isError === 'boolean' ? { isError: candidate.isError } : {}),
      };
    }
    if (candidate.type === 'attachment_ref') {
      const reference = block as { name?: unknown; mimeType?: unknown };
      if (typeof reference.name !== 'string' || typeof reference.mimeType !== 'string') {
        return undefined;
      }
      return {
        type: 'text',
        text: `[历史附件：${reference.name}（${reference.mimeType}），正文未重复载入]`,
      };
    }
  }
  return projectContentPart(block);
}

function projectToolResultPart(block: unknown): ToolResultContentPart | undefined {
  const projected = projectContentPart(block);
  if (!projected) return undefined;
  return projected.type === 'text'
    || projected.type === 'image_data'
    || projected.type === 'image_url'
    ? projected
    : undefined;
}

function collectPairedToolIds(history: readonly SessionMessage[]): ReadonlySet<string> {
  const calls = new Map<string, { count: number; position: number }>();
  const results = new Map<string, { count: number; position: number }>();
  let position = 0;

  for (const message of history) {
    if (!Array.isArray(message.blocks)) continue;
    for (const block of message.blocks) {
      position += 1;
      if (!block || typeof block !== 'object') continue;
      const candidate = block as { type?: unknown; id?: unknown; toolCallId?: unknown };
      if (
        message.role === 'assistant'
        && candidate.type === 'tool_use'
        && typeof candidate.id === 'string'
      ) {
        recordOccurrence(calls, candidate.id, position);
      }
      if (
        message.role === 'user'
        && candidate.type === 'tool_result'
        && typeof candidate.toolCallId === 'string'
      ) {
        recordOccurrence(results, candidate.toolCallId, position);
      }
    }
  }

  return new Set([...calls].flatMap(([id, call]) => {
    const result = results.get(id);
    return call.count === 1 && result?.count === 1 && call.position < result.position ? [id] : [];
  }));
}

function recordOccurrence(
  target: Map<string, { count: number; position: number }>,
  id: string,
  position: number,
): void {
  const existing = target.get(id);
  target.set(id, {
    count: (existing?.count ?? 0) + 1,
    position: existing?.position ?? position,
  });
}

function projectContentPart(block: unknown): ContentPart | undefined {
  if (!block || typeof block !== 'object') return undefined;
  const part = block as Record<string, unknown>;

  switch (part.type) {
    case 'text':
      return typeof part.text === 'string' && part.text.trim()
        ? { type: 'text', text: part.text }
        : undefined;
    case 'image_url':
      return typeof part.url === 'string'
        ? optionalImageFields({ type: 'image_url', url: part.url }, part)
        : undefined;
    case 'image_data':
      return typeof part.data === 'string' && typeof part.mimeType === 'string'
        ? optionalImageFields({ type: 'image_data', data: part.data, mimeType: part.mimeType }, part)
        : undefined;
    case 'audio_data':
      return typeof part.data === 'string' && typeof part.mimeType === 'string'
        ? {
            type: 'audio_data',
            data: part.data,
            mimeType: part.mimeType,
            ...(typeof part.name === 'string' ? { name: part.name } : {}),
            ...(typeof part.durationMs === 'number' ? { durationMs: part.durationMs } : {}),
          }
        : undefined;
    case 'file_data':
      return typeof part.data === 'string' && typeof part.mimeType === 'string'
        ? optionalFileFields({ type: 'file_data', data: part.data, mimeType: part.mimeType }, part)
        : undefined;
    case 'file_url':
      return typeof part.url === 'string' && typeof part.mimeType === 'string'
        ? optionalFileFields({ type: 'file_url', url: part.url, mimeType: part.mimeType }, part)
        : undefined;
    default:
      return undefined;
  }
}

function optionalImageFields<T extends Extract<ContentPart, { type: 'image_url' | 'image_data' }>>(
  base: T,
  source: Record<string, unknown>,
): T {
  return {
    ...base,
    ...(typeof source.name === 'string' ? { name: source.name } : {}),
    ...(typeof source.width === 'number' ? { width: source.width } : {}),
    ...(typeof source.height === 'number' ? { height: source.height } : {}),
  };
}

function optionalFileFields<T extends Extract<ContentPart, { type: 'file_data' | 'file_url' }>>(
  base: T,
  source: Record<string, unknown>,
): T {
  return {
    ...base,
    ...(typeof source.filename === 'string' ? { filename: source.filename } : {}),
    ...(typeof source.pageCount === 'number' ? { pageCount: source.pageCount } : {}),
  };
}
