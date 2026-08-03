// 把工具作者声明补齐并冻结为唯一的 Tool 形态。
import type { Tool } from './tool.js';
import { ToolDefinitionError } from '../errors.js';

export const DEFAULT_MAX_RESULT_BYTES = 50 * 1024;

type DefaultedToolFields =
  | 'id'
  | 'origin'
  | 'maxResultBytes'
  | 'isReadOnly'
  | 'isConcurrencySafe'
  | 'requiresUserInteraction';

type ToolDefinition<TInput, TOutput, TContext, TProgress> =
  Omit<Tool<TInput, TOutput, TContext, TProgress>, DefaultedToolFields>
  & Partial<Pick<Tool<TInput, TOutput, TContext, TProgress>, DefaultedToolFields>>;

/**
 * buildTool 只提供安全默认值，不创建第二套 BuiltTool 或公开 unsafe 方法。
 * Schema 派生、类型擦除和 MCP 权限加固属于 Registry 的内部边界。
 */
export function buildTool<TInput, TOutput, TContext, TProgress = never>(
  definition: ToolDefinition<TInput, TOutput, TContext, TProgress>,
): Tool<TInput, TOutput, TContext, TProgress> {
  const maxResultBytes = definition.maxResultBytes ?? DEFAULT_MAX_RESULT_BYTES;
  if (
    maxResultBytes !== Number.POSITIVE_INFINITY
    && (!Number.isSafeInteger(maxResultBytes) || maxResultBytes <= 0)
  ) {
    throw new ToolDefinitionError(
      `maxResultBytes must be a positive safe integer or Infinity, got ${maxResultBytes}`,
    );
  }

  const origin = definition.origin?.kind === 'mcp'
    ? Object.freeze({
        kind: 'mcp' as const,
        serverName: definition.origin.serverName,
        serverToolName: definition.origin.serverToolName,
      })
    : Object.freeze({ kind: 'builtin' as const });

  return Object.freeze({
    ...definition,
    id: definition.id ?? definition.name,
    origin,
    maxResultBytes,
    // 工具必须主动声明并发安全；忘记声明只会更保守，不会并发写坏共享状态。
    isReadOnly: definition.isReadOnly ?? (() => false),
    isConcurrencySafe: definition.isConcurrencySafe ?? (() => false),
    requiresUserInteraction: definition.requiresUserInteraction ?? (() => false),
    inputJsonSchemaOverride: definition.inputJsonSchemaOverride
      ? Object.freeze({ ...definition.inputJsonSchemaOverride })
      : undefined,
  });
}
