import { zodToJsonSchema } from 'zod-to-json-schema';
import type { ToolDef, BuiltTool, ToolDescriptor, ToolExecutionContext } from './types.js';

/**
 * Seals a ToolDef into an immutable BuiltTool ready for registration.
 *
 * Computes the JSON Schema descriptor lazily (once, on first call) so packages
 * that only import ToolDef types at build time pay no schema-serialization cost.
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
