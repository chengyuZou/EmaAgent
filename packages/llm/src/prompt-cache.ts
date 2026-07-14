import { createHash } from 'node:crypto';
import type { LlmMessage, LlmToolDef } from './types.js';

interface PromptPrefixInput {
  messages: readonly LlmMessage[];
  tools?: readonly LlmToolDef[];
}

/**
 * 统一工具顺序和 JSON Schema key 顺序，防止注册时序或对象构造顺序破坏 Provider KV Cache。
 * 数组顺序保留，因为数组在 JSON Schema 与提示词中可能具有业务语义。
 */
export function normalizeToolDefinitions(
  tools: readonly LlmToolDef[],
): LlmToolDef[] {
  return [...tools]
    .sort((left, right) => compareCodeUnits(left.name, right.name))
    .map((tool) => ({
      name: tool.name,
      description: tool.description,
      parameters: canonicalize(tool.parameters) as Record<string, unknown>,
    }));
}

/**
 * 计算截止最后一个 cacheBreakpoint 的规范化前缀指纹。
 * 动态后缀不参与 Hash；没有显式断点时返回 null，避免伪装成可缓存请求。
 */
export function computePromptPrefixHash(input: PromptPrefixInput): string | null {
  let breakpointIndex = -1;
  for (let index = 0; index < input.messages.length; index++) {
    if (input.messages[index]?.cacheBreakpoint) breakpointIndex = index;
  }
  if (breakpointIndex < 0) return null;

  const prefix = input.messages.slice(0, breakpointIndex + 1).map((message) => ({
    role: message.role,
    content: canonicalize(message.content),
  }));
  const serialized = JSON.stringify({
    version: 1,
    tools: normalizeToolDefinitions(input.tools ?? []),
    messages: prefix,
  });

  return createHash('sha256').update(serialized, 'utf8').digest('hex');
}

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (!value || typeof value !== 'object') return value;

  const record = value as Record<string, unknown>;
  const normalized: Record<string, unknown> = {};
  for (const key of Object.keys(record).sort(compareCodeUnits)) {
    normalized[key] = canonicalize(record[key]);
  }
  return normalized;
}

function compareCodeUnits(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}
