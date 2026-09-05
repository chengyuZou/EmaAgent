// Session Message → 模型历史的唯一转换入口:把持久化消息构建为 Provider 中立消息,
// 只保留完整配对的 Tool 配对;thinking 作为协议原生推理状态保留并携带生成来源
// (generatedBy),重放/删除由目标协议 Adapter 裁决。每条产出携带来源 Session
// Message id,供 Macro 摘要成功后映射 summarizedThroughMessageId(不进入 Compact 或 LLM 请求)。
import type {
  AssistantBlock,
  ContentPart,
  LlmGenerationSource,
  Message as ModelMessage,
  ToolResultContentPart,
  UserBlock,
} from '@ema-agent/llm';
import type {
  AttachmentBlock,
  Message as SessionMessage,
  SkillReferenceBlock,
} from '@ema-agent/session';
import {
  buildAttachmentMessages,
  type BuildAttachmentMessagesOptions,
} from './buildAttachmentMessages.js';

export interface HistoryMessage {
  readonly sessionMessageId: string;
  readonly message: ModelMessage;
}

/**
 * Session 中的 system 不是模型历史：System Prompt 每次重新生成，把它重放会
 * 制造重复事实。空块与未配对 tool_use/tool_result 被丢弃；thinking 保留为
 * 原生推理状态并 attach 所属 Turn 的生成来源。产出数组可能比输入短，
 * 身份映射只允许使用 sessionMessageId，不可用下标对齐输入。
 */
export async function buildHistoryMessages(
  history: readonly SessionMessage[],
  resolveGenerationTarget: (turnId: string) => LlmGenerationSource | undefined,
  attachmentOptions: BuildAttachmentMessagesOptions,
): Promise<HistoryMessage[]> {
  const messages: HistoryMessage[] = [];
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
        const content: UserBlock[] = [];
        for (const block of message.blocks) {
          const projected = await buildUserBlocks(block, pairedToolIds, attachmentOptions);
          if (projected) content.push(...projected);
        }
        if (content.length > 0) {
          messages.push({
            sessionMessageId: message.id,
            message: { role: 'user', content },
          });
        }
      }
      continue;
    }

    // 中断的 Assistant 是流式恢复事实，不是已经完成的模型回复。
    if (!message.interrupted && Array.isArray(message.blocks)) {
      const content = message.blocks
        .map((block) => buildAssistantBlock(block, pairedToolIds))
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

function buildAssistantBlock(
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
  // 原生推理状态按协议判别联合透传；是否重放由目标协议 Adapter 依据 generatedBy 裁决。
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
  if (
    candidate.type === 'reasoning'
    && typeof candidate.id === 'string'
    && candidate.id.length > 0
  ) {
    const summaryText = (block as { summaryText?: unknown }).summaryText;
    const encryptedContent = (block as { encryptedContent?: unknown }).encryptedContent;
    return {
      type: 'reasoning',
      id: candidate.id,
      ...(typeof summaryText === 'string' && summaryText.length > 0 ? { summaryText } : {}),
      ...(typeof encryptedContent === 'string' && encryptedContent.length > 0
        ? { encryptedContent }
        : {}),
    };
  }
  if (
    candidate.type === 'gemini_thought'
    && typeof candidate.text === 'string'
    && candidate.text.trim()
  ) {
    const thoughtSignature = (block as { thoughtSignature?: unknown }).thoughtSignature;
    return {
      type: 'gemini_thought',
      text: candidate.text,
      ...(typeof thoughtSignature === 'string' && thoughtSignature.length > 0
        ? { thoughtSignature }
        : {}),
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

async function buildUserBlocks(
  block: unknown,
  pairedToolIds: ReadonlySet<string>,
  attachmentOptions: BuildAttachmentMessagesOptions,
): Promise<UserBlock[] | undefined> {
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
              .map(buildToolResultContentPart)
              .filter((part): part is ToolResultContentPart => part !== undefined)
          : undefined;
      if (content === undefined) return undefined;
      return [{
        type: 'tool_result',
        toolCallId: candidate.toolCallId,
        content,
        ...(typeof candidate.isError === 'boolean' ? { isError: candidate.isError } : {}),
      }];
    }
    if (
      candidate.type === 'image_reference'
      || candidate.type === 'pasted_text_reference'
      || candidate.type === 'file_reference'
    ) {
      // 块的字段合法性在入库校验(message.parseMessageBlocksJson)已保证。
      return buildAttachmentMessages(block as AttachmentBlock, attachmentOptions);
    }
    if (candidate.type === 'skill_reference') {
      const reference = block as Partial<SkillReferenceBlock>;
      if (typeof reference.name !== 'string' || typeof reference.path !== 'string') {
        return undefined;
      }
      return [{
        type: 'text',
        text: renderSkillReferenceForModel(reference as SkillReferenceBlock),
      }];
    }
  }
  const part = buildContentPart(block);
  return part === undefined ? undefined : [part];
}

/**
 * 当前 Turn 与历史重放共用同一文案：只陈述"用户当时选择过"这个事实。
 * 当前可用性由本 Turn 冻结的 Skill Pool 判定——技能已删/已禁用时,
 * Skill 工具会返回明确的不可用错误,这里不预先承诺它仍可调用。
 */
export function renderSkillReferenceForModel(reference: SkillReferenceBlock): string {
  return [
    `[用户选择的 Skill: ${reference.name} (${reference.path})]`,
    '这是用户的选择记录。若该技能当前可用,可调用 Skill 工具加载它的完整指令;若已被删除或禁用,Skill 工具会返回不可用,忽略即可。',
  ].join('\n');
}

function buildToolResultContentPart(block: unknown): ToolResultContentPart | undefined {
  const projected = buildContentPart(block);
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
        && !message.interrupted
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

function buildContentPart(block: unknown): ContentPart | undefined {
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
