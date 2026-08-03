// 把工具作者提供的定义封装成注册表可以安全使用的不可变工具。
import { zodToJsonSchema } from 'zod-to-json-schema';
import type { PermissionIntent } from '@ema-agent/permission';
import { ToolDefinitionError } from '../errors.js';
import type {
  BuiltTool,
  ToolContextValidation,
  ToolDef,
  ToolDescriptor,
  ToolOrigin,
} from './tool.js';

export const DEFAULT_MAX_RESULT_BYTES = 50 * 1024;

/**
 * 把 ToolDef 封闭为不可变 BuiltTool,可注册。
 *
 * 懒计算 JSON Schema descriptor(首次调用时一次),以便只在 build 时
 * import ToolDef 类型的包不付 schema 序列化代价。
 *
 * THostContext 仅在此处校验作者写的 validateContext 签名;返回的 BuiltTool 在
 * 类型擦除边界通过 unsafeValidateContext/unsafeExecute 收 unknown,
 * 让注册表和执行器不必知道具体宿主 Context 类型。
 */
export function buildTool<TInput, TOutput, THostContext, TToolContext>(
  def: ToolDef<TInput, TOutput, THostContext, TToolContext>,
): BuiltTool<TInput, TOutput, TToolContext> {
  const maxResultBytes = def.maxResultBytes ?? DEFAULT_MAX_RESULT_BYTES;
  if (
    maxResultBytes !== Number.POSITIVE_INFINITY
    && (!Number.isSafeInteger(maxResultBytes) || maxResultBytes <= 0)
  ) {
    throw new ToolDefinitionError(`maxResultBytes must be a positive safe integer or Infinity, got ${maxResultBytes}`);
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
  const validateContext = def.validateContext.bind(def);
  // 类型擦除边界:注册表/执行器持 unknown,在此断言回工具定义的 THostContext。
  const unsafeValidateContext = (context: unknown): ToolContextValidation<TToolContext> =>
    validateContext(context as THostContext);
  const unsafeExecute = (
    input: unknown,
    context: unknown,
  ): Promise<unknown> => execute(input as TInput, context as TToolContext);
  const getPermissionIntent = async (
    input: TInput,
    context: TToolContext,
  ): Promise<PermissionIntent> => {
    const intent = await def.getPermissionIntent(input, context);
    if (origin.kind === 'builtin') return intent;

    // MCP annotation 由远端提供，不能把外部 Tool 自报的低风险或免询问当作信任依据。
    return {
      riskLevel: intent.riskLevel === 'high' ? 'high' : 'medium',
      accessType: 'execute' as const,
      promptPolicy: 'whenRequired' as const,
    };
  };
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
    requires: def.requires ? [...def.requires] as string[] : undefined,
    validateInput: def.validateInput,
    isReadOnly: def.isReadOnly,
    isConcurrencySafe: def.isConcurrencySafe,
    requiresUserInteraction: def.requiresUserInteraction ?? (() => false),
    getPermissionIntent,
    descriptor,
    execute,
    unsafeExecute,
    unsafeValidateContext,
    parseInput,
  });
}
