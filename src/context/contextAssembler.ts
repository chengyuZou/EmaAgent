// 在模型调用前把 Prompt、历史、本轮输入、临时召回和工具清单装配成不可变请求快照。
import type { Message, LlmToolDef } from '@ema-agent/llm';
import type { ToolManifestEntry } from '@ema-agent/tools';
import { ContextAssemblyError } from './errors.js';
import type {
  ContextAssemblyInput,
  ContextHistoryCompactor,
  ContextContribution,
  ModelContextSnapshot,
} from './types.js';
import { computePromptPrefixHash } from './promptPrefix.js';
import { renderRuntimeEnvironment } from './runtimeEnvironment.js';

export class ContextAssembler {
  assemble(input: ContextAssemblyInput): ModelContextSnapshot {
    const parts = buildContextParts(input);
    return buildSnapshot(
      input,
      [...parts.prefix, ...parts.history, ...parts.suffix],
      parts.history,
      parts.tools,
    );
  }

  async assembleCompacted(
    input: ContextAssemblyInput,
    compactHistory: ContextHistoryCompactor,
    options?: { readonly force?: boolean },
  ): Promise<ModelContextSnapshot> {
    const parts = buildContextParts(input);
    const messages = await compactHistory({
      prefixMessages: parts.prefix,
      historyMessages: parts.history,
      suffixMessages: parts.suffix,
      tools: parts.tools,
    }, options);
    const historyEnd = Math.max(parts.prefix.length, messages.length - parts.suffix.length);
    const compactedHistory = messages.slice(parts.prefix.length, historyEnd);
    return buildSnapshot(input, messages, compactedHistory, parts.tools);
  }
}

interface ContextParts {
  prefix: Message[];
  history: Message[];
  suffix: Message[];
  tools: LlmToolDef[];
}

function buildContextParts(input: ContextAssemblyInput): ContextParts {
    const contributions = input.contributions ?? [];
    assertUniqueContributionIds(contributions);

    const systemMessages = input.prompt.systemBlocks.map((block): Message => ({
      role: 'system',
      content: block.content,
      ...(block.cacheBreakpoint ? { cacheBreakpoint: true as const } : {}),
    }));
    const promptContextMessages = input.prompt.contextBlocks.map((block): Message => ({
      role: 'user',
      content: block.content,
      ...(block.cacheBreakpoint ? { cacheBreakpoint: true as const } : {}),
    }));
    const environmentMessages: Message[] = input.environment
      ? [{
          role: 'user',
          content: renderRuntimeEnvironment(input.environment),
          cacheBreakpoint: true,
        }]
      : [];
    const suffix = [
      ...messagesAt(contributions, 'beforeCurrentTurn'),
      ...input.currentTurn,
      ...messagesAt(contributions, 'afterCurrentTurn'),
    ].map(cloneAndFreeze);
    const tools = (input.toolManifest?.entries ?? []).map(toLlmToolDef);

    return {
      prefix: [
        ...systemMessages,
        ...promptContextMessages,
        ...environmentMessages,
      ].map(cloneAndFreeze),
      history: input.history.map(cloneAndFreeze),
      suffix,
      tools,
    };
}

function buildSnapshot(
  input: ContextAssemblyInput,
  messages: readonly Message[],
  history: readonly Message[],
  tools: readonly LlmToolDef[],
): ModelContextSnapshot {
  // 最终断点随单次请求尾部移动，使历史和已经完成的工具轮次进入增量缓存；
  // 只标记请求投影，不能写回 Session 历史或压缩器的工作消息。
  const frozenMessages = Object.freeze(markFinalCacheBreakpoint(messages));
  const frozenTools = Object.freeze(tools.map(cloneAndFreeze));
  return Object.freeze({
    promptRevision: input.prompt.revision,
    toolManifestRevision: input.toolManifest?.revision ?? null,
    messages: frozenMessages,
    history: Object.freeze(history.map(cloneAndFreeze)),
    tools: frozenTools,
    cache: Object.freeze({
      productPromptRevision: input.prompt.revisions.product,
      activeCharacterRevision: input.prompt.revisions.activeCharacter,
      turnPromptRevision: input.prompt.revisions.turn,
      completePromptRevision: input.prompt.revisions.complete,
      toolManifestRevision: input.toolManifest?.revision ?? null,
      prefixHash: computePromptPrefixHash({
        messages: frozenMessages,
        tools: frozenTools,
      }),
    }),
  });
}

function markFinalCacheBreakpoint(messages: readonly Message[]): Message[] {
  const projected = messages.map((message) => structuredClone(message));
  for (let index = projected.length - 1; index >= 0; index -= 1) {
    const message = projected[index];
    if (!message || !canCarryCacheBreakpoint(message)) continue;
    if (!message.cacheBreakpoint) {
      projected[index] = { ...message, cacheBreakpoint: true } as Message;
    }
    break;
  }
  return projected.map(deepFreeze);
}

function canCarryCacheBreakpoint(message: Message): boolean {
  return message.content.length > 0;
}

function messagesAt(
  contributions: readonly ContextContribution[],
  placement: ContextContribution['placement'],
): Message[] {
  return contributions
    .filter((contribution) => contribution.placement === placement)
    .map((contribution) => contribution.message);
}

function assertUniqueContributionIds(
  contributions: readonly ContextContribution[],
): void {
  const ids = new Set<string>();
  for (const contribution of contributions) {
    if (!contribution.id.trim()) {
      throw new ContextAssemblyError(
        'context/empty-contribution-id',
        'Context contribution id 不能为空。',
      );
    }
    if (ids.has(contribution.id)) {
      throw new ContextAssemblyError(
        'context/duplicate-contribution-id',
        `Context contribution id 重复：${contribution.id}。`,
      );
    }
    ids.add(contribution.id);
  }
}

function toLlmToolDef(entry: ToolManifestEntry): LlmToolDef {
  return cloneAndFreeze({
    name: entry.name,
    description: entry.description,
    parameters: structuredClone(entry.inputJsonSchema) as Record<string, unknown>,
  });
}

function cloneAndFreeze<T>(value: T): T {
  return deepFreeze(structuredClone(value));
}

function deepFreeze<T>(value: T): T {
  if (value === null || typeof value !== 'object' || Object.isFrozen(value)) {
    return value;
  }
  for (const key of Reflect.ownKeys(value)) {
    deepFreeze(Reflect.get(value, key));
  }
  return Object.freeze(value);
}
