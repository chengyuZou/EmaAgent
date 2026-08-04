// 把 Tool 的 Zod 输入契约投影为 Provider 可发送的 JSON Schema。
import { zodToJsonSchema } from 'zod-to-json-schema';
import type { Tool } from './tool.js';

// 不同 Tool 的具体泛型只在执行时恢复，Schema 投影只读取输入契约。
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyTool = Tool<any, any, any, any>;

/**
 * 返回独立的协议投影，调用方可以继续规范化或冻结，不能借此改写 Tool 定义。
 * MCP 已提供的可信 Schema 优先；内置工具由唯一 Zod 契约派生。
 */
export function toolInputJsonSchema(tool: AnyTool): Record<string, unknown> {
  return structuredClone(
    tool.inputJsonSchemaOverride
      ?? zodToJsonSchema(tool.inputSchema, {
        target: 'openApi3',
        $refStrategy: 'none',
      }) as Record<string, unknown>,
  );
}
