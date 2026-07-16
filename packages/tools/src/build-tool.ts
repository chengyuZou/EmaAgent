// 这里把工具作者提供的定义封装成注册表可以安全使用的不可变工具。
import { zodToJsonSchema } from 'zod-to-json-schema';
import type { ToolDef, BuiltTool, ToolDescriptor, ToolExecutionContext } from './types.js';

/**
 * 把 ToolDef 封闭为不可变 BuiltTool,可注册。
 *
 * 懒计算 JSON Schema descriptor(首次调用时一次),以便只在 build 时
 * import ToolDef 类型的包不付 schema 序列化代价。
 */
export function buildTool<TInput, TOutput>(
  def: ToolDef<TInput, TOutput>,
): BuiltTool<TInput, TOutput> {
  let cachedDescriptor: ToolDescriptor | undefined;

  const descriptor = (): ToolDescriptor => {
    if (!cachedDescriptor) {
      cachedDescriptor = {
        name: def.name,
        description: def.description,
        inputJsonSchema: zodToJsonSchema(def.inputSchema, {
          target: 'openApi3',
          $refStrategy: 'none',
        }) as Record<string, unknown>,
      };
    }
    return cachedDescriptor;
  };

  const parseInput = (raw: unknown): TInput => def.inputSchema.parse(raw);

  const execute = def.execute.bind(def);
  const unsafeExecute = (input: unknown, ctx: ToolExecutionContext): Promise<unknown> =>
    execute(input as TInput, ctx);

  return Object.freeze({
    id: def.id ?? def.name,
    name: def.name,
    description: def.description,
    inputSchema: def.inputSchema,
    isReadOnly: def.isReadOnly,
    isConcurrencySafe: def.isConcurrencySafe,
    permissionMeta: Object.freeze({ ...def.permissionMeta }),
    descriptor,
    execute,
    unsafeExecute,
    parseInput,
  });
}
