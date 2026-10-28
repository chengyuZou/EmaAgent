import type { Tool } from './tool.js';
import { ToolDefinitionError } from '../errors.js';

export const DEFAULT_MAX_RESULT_BYTES = 50 * 1024;

type DefaultedToolFields =
  | 'id'
  | 'origin'
  | 'maxResultBytes'
  | 'isConcurrencySafe'
  | 'requiresUserInteraction'
  | 'checkPermissions';

type ToolDefinition<TInput, TOutput, TContext, TProgress> =
  Omit<Tool<TInput, TOutput, TContext, TProgress>, DefaultedToolFields>
  & Partial<Pick<Tool<TInput, TOutput, TContext, TProgress>, DefaultedToolFields>>;

/**
 * 未声明并发安全的工具默认独占执行, 避免同时修改共享状态.
 * 未提供权限检查信息时默认需要确认, 由 Permission 再按规则和模式判断.
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
    checkPermissions: definition.checkPermissions ?? (async () => ({ kind: 'tool', defaultDecision: 'ask' })),
    id: definition.id ?? definition.name,
    origin,
    maxResultBytes,
    // 工具必须主动声明并发安全;忘记声明只会更保守,不会并发写坏共享状态.
    isConcurrencySafe: definition.isConcurrencySafe ?? (() => false),
    requiresUserInteraction: definition.requiresUserInteraction ?? (() => false),
    inputJsonSchemaOverride: definition.inputJsonSchemaOverride
      ? Object.freeze({ ...definition.inputJsonSchemaOverride })
      : undefined,
  });
}
