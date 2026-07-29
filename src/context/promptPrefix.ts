// 规范化 Tool Manifest 并计算真实请求缓存前缀的身份指纹。
import { createHash } from 'node:crypto';
import type { LlmToolDef, Message } from '@ema-agent/llm';

interface PromptPrefixInput {
  messages: readonly Message[];
  tools?: readonly LlmToolDef[];
}

/**
 * 规范化 JSON Schema key，但保留 Tool Manifest 已冻结的工具顺序。
 * 工具数组本身参与 Provider 缓存键；在 Context 再次平铺排序会打散 Builtin/MCP 分区，
 * 也会让诊断 Hash 掩盖真实请求顺序变化。
 */
export function normalizeToolDefinitions(
  tools: readonly LlmToolDef[],
): LlmToolDef[] {
  return tools.map((tool) => ({
    name: tool.name,
    description: tool.description,
    parameters: canonicalize(tool.parameters) as Record<string, unknown>,
  }));
}

/**
 * 计算截止最后一个 cacheBreakpoint 的规范化前缀指纹。
 * 只有最后断点之后的消息不参与 Hash；ContextAssembler 会把最终断点移动到
 * 本次请求尾部，因此生产快照中的历史、当前 Turn 和已完成工具轮次通常都会参与。
 * 没有显式断点时返回 null，避免伪装成可缓存请求。
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
