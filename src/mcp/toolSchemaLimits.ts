// MCP 工具发现结果在进入注册表和持久缓存前统一执行数量与总字节限制。

import { Buffer } from 'node:buffer';
import { McpToolSchemaLimitError } from './errors.js';

/** 单个 MCP Server 暴露过多工具时，Schema 本身已经不适合直接进入模型窗口。 */
export const MAX_MCP_TOOLS_PER_SERVER = 256;
/** 该上限约束工具名称、描述、annotations 与 input schema 的序列化总量。 */
export const MAX_MCP_TOOL_SCHEMA_BYTES = 1024 * 1024;

export function assertMcpToolSchemaLimits(
  serverName: string,
  tools: readonly unknown[],
): void {
  if (tools.length > MAX_MCP_TOOLS_PER_SERVER) {
    throw new McpToolSchemaLimitError(
      serverName,
      `reported ${tools.length} tools; limit is ${MAX_MCP_TOOLS_PER_SERVER}`,
    );
  }

  let totalBytes = 2;
  for (const tool of tools) {
    const serialized = JSON.stringify(tool);
    if (serialized !== undefined) {
      totalBytes += Buffer.byteLength(serialized, 'utf8') + 1;
    }
    if (totalBytes > MAX_MCP_TOOL_SCHEMA_BYTES) {
      throw new McpToolSchemaLimitError(
        serverName,
        `tool schemas use more than ${MAX_MCP_TOOL_SCHEMA_BYTES} UTF-8 bytes`,
      );
    }
  }
}
