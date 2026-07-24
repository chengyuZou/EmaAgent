// 把工具作者提供的定义封装成注册表可以安全使用的不可变工具。
import { zodToJsonSchema } from 'zod-to-json-schema';
import type {
  ToolDef,
  BuiltTool,
  ToolDescriptor,
  ToolExecutionScope,
  ToolInvocationContext,
  ToolOrigin,
} from './types.js';

export const DEFAULT_MAX_RESULT_BYTES = 50 * 1024;

/**
 * 把 ToolDef 封闭为不可变 BuiltTool,可注册。
 *
 * 懒计算 JSON Schema descriptor(首次调用时一次),以便只在 build 时
 * import ToolDef 类型的包不付 schema 序列化代价。
 */
export function buildTool<TInput, TOutput>(
  def: ToolDef<TInput, TOutput>,
): BuiltTool<TInput, TOutput> {
  const maxResultBytes = def.maxResultBytes ?? DEFAULT_MAX_RESULT_BYTES;
  if (
    maxResultBytes !== Number.POSITIVE_INFINITY
    && (!Number.isSafeInteger(maxResultBytes) || maxResultBytes <= 0)
  ) {
    throw new RangeError(`maxResultBytes must be a positive safe integer or Infinity, got ${maxResultBytes}`);
  }
  const origin: ToolOrigin = def.origin?.kind === 'mcp'
    ? Object.freeze({
        kind: 'mcp',
        serverName: def.origin.serverName,
        serverToolName: def.origin.serverToolName,
      })
    : Object.freeze({ kind: 'builtin' });

  let cachedDescriptor: ToolDescriptor | undefined;

  const descriptor = (): ToolDescriptor => {
    if (!cachedDescriptor) {
      cachedDescriptor = {
        name: def.name,
        description: def.description,
        inputJsonSchema: def.inputJsonSchemaOverride ?? zodToJsonSchema(def.inputSchema, {
          target: 'openApi3',
          $refStrategy: 'none',
        }) as Record<string, unknown>,
      };
    }
    return cachedDescriptor;
  };

  const parseInput = (raw: unknown): TInput => def.inputSchema.parse(raw);

  const execute = def.execute.bind(def);
  const unsafeExecute = (
    input: unknown,
    ctx: ToolInvocationContext,
    scope: ToolExecutionScope,
  ): Promise<unknown> => execute(input as TInput, ctx, scope);

  return Object.freeze({
    id: def.id ?? def.name,
    name: def.name,
    origin,
    description: def.description,
    getToolUseSummary: def.getToolUseSummary,
    inputSchema: def.inputSchema,
    inputJsonSchemaOverride: def.inputJsonSchemaOverride
      ? Object.freeze({ ...def.inputJsonSchemaOverride })
      : undefined,
    maxResultBytes,
    validateInput: def.validateInput,
    isReadOnly: def.isReadOnly,
    isConcurrencySafe: def.isConcurrencySafe,
    requiresUserInteraction: def.requiresUserInteraction ?? (() => false),
    permissionMeta: Object.freeze({ ...def.permissionMeta }),
    descriptor,
    execute,
    unsafeExecute,
    parseInput,
  });
}
