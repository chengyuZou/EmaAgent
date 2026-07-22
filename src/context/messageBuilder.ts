// 把持久化 Session Message 投影为 Provider 无关的 LLM Message。
import type {
  AssistantBlock,
  ContentPart,
  Message as ModelMessage,
  ToolResultContentPart,
  UserBlock,
} from '@ema-agent/llm';
import type { Message as SessionMessage } from '@ema-agent/session';

interface NarrativeTimeline {
  name: string;
  text: string;
}

/** 历史投影只保留跨 Provider 可安全重放的内容。 */
export function buildModelMessages(history: readonly SessionMessage[]): ModelMessage[] {
  const messages: ModelMessage[] = [];
  const pairedToolIds = collectPairedToolIds(history);

  for (const message of history) {
    if (message.role === 'system') {
      messages.push({
        role: 'system',
        content: typeof message.blocks === 'string' ? message.blocks : '',
      });
      continue;
    }

    if (message.role === 'user') {
      if (message.kind === 'narrative_context') {
        const narrative = projectNarrativeContext(message.blocks);
        if (narrative) messages.push(narrative);
        continue;
      }
      if (typeof message.blocks === 'string') {
        messages.push({ role: 'user', content: message.blocks });
        continue;
      }
      if (Array.isArray(message.blocks)) {
        const content = message.blocks
          .map((block) => projectUserBlock(block, pairedToolIds))
          .filter((part): part is UserBlock => part !== undefined);
        if (content.length > 0) messages.push({ role: 'user', content });
      }
      continue;
    }

    if (Array.isArray(message.blocks)) {
      const content = message.blocks
        .map((block) => projectAssistantBlock(block, pairedToolIds))
        .filter((block): block is AssistantBlock => block !== undefined);
      if (content.length > 0) messages.push({ role: 'assistant', content });
    }
  }

  return messages;
}

function projectNarrativeContext(blocks: unknown): ModelMessage | undefined {
  if (!blocks || typeof blocks !== 'object' || Array.isArray(blocks)) return undefined;
  const timelines = (blocks as { timelines?: unknown }).timelines;
  if (!Array.isArray(timelines)) return undefined;

  const sections = timelines
    .filter(isNarrativeTimeline)
    .map((timeline) => `## ${timeline.name}\n${timeline.text}`);
  if (sections.length === 0) return undefined;

  return {
    role: 'user',
    content: '[NARRATIVE CONTEXT - do not quote verbatim; use as background]\n\n'
      + sections.join('\n\n'),
  };
}

function isNarrativeTimeline(value: unknown): value is NarrativeTimeline {
  if (!value || typeof value !== 'object') return false;
  const candidate = value as Partial<NarrativeTimeline>;
  return typeof candidate.name === 'string' && typeof candidate.text === 'string';
}

function projectAssistantBlock(
  block: unknown,
  pairedToolIds: ReadonlySet<string>,
): AssistantBlock | undefined {
  if (!block || typeof block !== 'object') return undefined;
  const candidate = block as {
    type?: unknown;
    text?: unknown;
    id?: unknown;
    name?: unknown;
    args?: unknown;
  };
  if (candidate.type === 'text' && typeof candidate.text === 'string') {
    return { type: 'text', text: candidate.text };
  }
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
      toolUseId?: unknown;
      content?: unknown;
      isError?: unknown;
    };
    if (candidate.type === 'tool_result') {
      if (typeof candidate.toolUseId !== 'string' || !pairedToolIds.has(candidate.toolUseId)) {
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
        toolUseId: candidate.toolUseId,
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
  const toolUseIds = new Set<string>();
  const toolResultIds = new Set<string>();

  for (const message of history) {
    if (!Array.isArray(message.blocks)) continue;
    for (const block of message.blocks) {
      if (!block || typeof block !== 'object') continue;
      const candidate = block as { type?: unknown; id?: unknown; toolUseId?: unknown };
      if (candidate.type === 'tool_use' && typeof candidate.id === 'string') {
        toolUseIds.add(candidate.id);
      }
      if (candidate.type === 'tool_result' && typeof candidate.toolUseId === 'string') {
        toolResultIds.add(candidate.toolUseId);
      }
    }
  }

  return new Set([...toolUseIds].filter((id) => toolResultIds.has(id)));
}

function projectContentPart(block: unknown): ContentPart | undefined {
  if (!block || typeof block !== 'object') return undefined;
  const part = block as Record<string, unknown>;

  switch (part.type) {
    case 'text':
      return typeof part.text === 'string' ? { type: 'text', text: part.text } : undefined;
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
