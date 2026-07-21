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

export class ContextAssembler {
  assemble(input: ContextAssemblyInput): ModelContextSnapshot {
    const parts = buildContextParts(input);
    return buildSnapshot(input, [...parts.prefix, ...parts.history, ...parts.suffix], parts.tools);
  }

  async assembleCompacted(
    input: ContextAssemblyInput,
    compactHistory: ContextHistoryCompactor,
  ): Promise<ModelContextSnapshot> {
    const parts = buildContextParts(input);
    const messages = await compactHistory({
      prefixMessages: parts.prefix,
      historyMessages: parts.history,
      suffixMessages: parts.suffix,
      tools: parts.tools,
    });
    return buildSnapshot(input, messages, parts.tools);
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

    const systemMessage: Message = {
      role: 'system',
      content: input.prompt.systemText,
      cacheBreakpoint: true,
    };
    const suffix = [
      ...messagesAt(contributions, 'beforeCurrentTurn'),
      ...input.currentTurn,
      ...messagesAt(contributions, 'afterCurrentTurn'),
    ].map(cloneAndFreeze);
    const tools = (input.toolManifest?.entries ?? []).map(toLlmToolDef);

    return {
      prefix: [cloneAndFreeze(systemMessage)],
      history: input.history.map(cloneAndFreeze),
      suffix,
      tools,
    };
}

function buildSnapshot(
  input: ContextAssemblyInput,
  messages: readonly Message[],
  tools: readonly LlmToolDef[],
): ModelContextSnapshot {
  return Object.freeze({
    promptRevision: input.prompt.revision,
    toolManifestRevision: input.toolManifest?.revision ?? null,
    messages: Object.freeze(messages.map(cloneAndFreeze)),
    tools: Object.freeze(tools.map(cloneAndFreeze)),
  });
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
