import type { Client }           from '@modelcontextprotocol/sdk/client/index.js';
import { z }                     from 'zod';
import { buildTool, contextOk }  from '@ema-agent/tools';
import type { Tool }             from '@ema-agent/tools';
import type { McpToolInfo }      from './types.js';
import { buildMcpToolName }      from './types.js';
import type { McpRegistry }      from './registry.js';
import type { McpToolOutput }    from './execution.js';
import { projectMcpToolOutput }  from './execution.js';
import { assertMcpToolSchemaLimits } from './toolSchemaLimits.js';

const MAX_DESCRIPTION_LEN = 4096;

// 单次调用的取消信号来自 ToolInvocation, 无需额外的宿主业务对象.
type McpToolContext = Record<string, never>;

/**
 * 拉取失败或工具定义超限时抛错, 由 Registry 更新连接状态.
 * 只有服务器成功返回空列表时才返回 [].
 */
export async function discoverServerTools(
  serverName: string,
  client:     Client,
  signal?:    AbortSignal,
): Promise<McpToolInfo[]> {
  const result = await client.listTools(undefined, { signal });
  assertMcpToolSchemaLimits(serverName, result.tools);

  return result.tools.map((tool) => {
    const desc = tool.description ?? '';
    return {
      serverToolName:     tool.name,
      qualifiedName:      buildMcpToolName(serverName, tool.name),
      originalServerName: serverName,   // 原样保留,供连接查找
      description:        desc.length > MAX_DESCRIPTION_LEN
        ? desc.slice(0, MAX_DESCRIPTION_LEN) + '... [truncated]'
        : desc,
      inputSchema:   (tool.inputSchema ?? { type: 'object', properties: {} }) as Record<string, unknown>,
      reportedDestructive: tool.annotations?.destructiveHint ?? false,
    };
  });
}

export function buildMcpBuiltTool(
  info:     McpToolInfo,
  registry: McpRegistry,
): Tool<Record<string, unknown>, McpToolOutput, McpToolContext> {
  // qualifiedName 替换了连字符和点等字符, 拆分后无法还原连接 Map 使用的原始名字.
  const serverName = info.originalServerName;

  return buildTool({
    id:                mcpToolId(serverName, info.serverToolName),
    name:              info.qualifiedName,
    origin: {
      kind: 'mcp',
      serverName,
      serverToolName: info.serverToolName,
    },
    description:       `[MCP:${serverName}] ${info.description}`,
    // Zod 只检查输入是对象, 模型使用服务器提供的 JSON Schema.
    inputSchema:       z.record(z.string(), z.unknown()),
    inputJsonSchemaOverride: info.inputSchema,
    // 远端的 readOnlyHint 不能证明调用没有副作用, 因此不据此放行权限或并发执行.
    isConcurrencySafe: () => false,
    getToolUseSummary: () => `${serverName} / ${info.serverToolName}`,
    // 只传递 MCP 声明, 确认要求和可复用范围由 Permission 决定.
    checkPermissions: async () => ({
      kind: 'mcp',
      reportedDestructive: info.reportedDestructive,
    }),
    validateContext: () => contextOk({}),
    execute: (input, _context, invocation) => registry.callTool(
      serverName,
      info.serverToolName,
      input,
      invocation.signal,
    ),
    mapResultToModelContent: projectMcpToolOutput,
  });
}

/** 编码名字中的分隔符, 避免不同的 server/tool 组合产生同一个 id. */
function mcpToolId(serverName: string, serverToolName: string): string {
  return `mcp:${encodeURIComponent(serverName)}:${encodeURIComponent(serverToolName)}`;
}
