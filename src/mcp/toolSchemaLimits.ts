import { Buffer } from 'node:buffer';
import { McpToolSchemaLimitError } from './errors.js';

/** 工具发现和缓存写入使用同一数量限制, 超限时整批拒绝. */
export const MAX_MCP_TOOLS_PER_SERVER = 256;
/** 按工具名称, 描述, annotations 和 input schema 的序列化总字节数检查. */
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
