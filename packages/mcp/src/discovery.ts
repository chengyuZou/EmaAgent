// 这里发现 MCP Server 暴露的工具，并把它们转换成 EmaAgent 的可注册工具。
import type { Client }           from '@modelcontextprotocol/sdk/client/index.js';
import { z }                     from 'zod';
import type { BuiltTool, ToolDescriptor, ToolExecutionContext } from '@ema-agent/tools';
import type { ToolPermissionMeta } from '@ema-agent/permission';
import type { McpToolInfo }      from './types.js';
import { buildMcpToolName }      from './types.js';
import type { McpRegistry }      from './registry.js';

const MAX_DESCRIPTION_LEN = 2048;

// ── 工具发现 ────────────────────────────────────────────────────────────────────

/**
 * 从已连接的 MCP 服务器拉取工具列表,返回结构化信息。
 * 服务器无 tools 能力或拉取失败时返回 []。
 */
export async function discoverServerTools(
  serverName: string,
  client:     Client,
): Promise<McpToolInfo[]> {
  let result: Awaited<ReturnType<typeof client.listTools>>;
  try {
    result = await client.listTools();
  } catch {
    return [];
  }

  return result.tools.map((tool) => {
    const desc = tool.description ?? '';
    return {
      serverToolName:     tool.name,
      qualifiedName:      buildMcpToolName(serverName, tool.name),
      originalServerName: serverName,   // 原样保留,供连接查找
      description:        desc.length > MAX_DESCRIPTION_LEN
        ? desc.slice(0, MAX_DESCRIPTION_LEN) + '… [truncated]'
        : desc,
      inputSchema:   (tool.inputSchema ?? { type: 'object', properties: {} }) as Record<string, unknown>,
      reportedReadOnly:    tool.annotations?.readOnlyHint     ?? false,
      reportedDestructive: tool.annotations?.destructiveHint ?? false,
    };
  });
}

// ── MCP 工具的 BuiltTool 工厂 ──────────────────────────────────────────────────
//
// MCP 工具不能用标准 buildTool() 辅助,因其 input schema 来自服务器(JSON Schema,
// 非 Zod schema)。我们直接构造 BuiltTool 对象,让 LLM 看到真实 JSON Schema,
// 而 Zod 校验保持宽松(校验本就是服务器的事)。

export function buildMcpBuiltTool(
  info:     McpToolInfo,
  registry: McpRegistry,
): BuiltTool {
  // 用原始(未清洗)服务器名查连接。qualifiedName 的连字符/点已替换成下划线;
  // 连接 map 按原始名索引,故拆分 qualifiedName 会破坏名字含非字母数字的服务器。
  const serverName = info.originalServerName;
  const inputZod      = z.record(z.unknown()); // 宽松 - MCP 服务器校验

  const permissionMeta: ToolPermissionMeta = Object.freeze({
    // MCP annotations 由远端 Server 自己填写。危险提示可以升级风险，安全提示
    // 不能降级；否则恶意 Server 可伪装成只读工具绕过 auto 模式确认。
    riskLevel:  info.reportedDestructive ? 'high' : 'medium',
    accessType: 'execute',
  });

  const descriptor = (): ToolDescriptor => ({
    name:           info.qualifiedName,
    description:    `[MCP:${serverName}] ${info.description}`,
    inputJsonSchema: info.inputSchema,         // ← 给 LLM 的真实 MCP schema
  });

  // execute 接 `unknown`,为与 BuiltTool<unknown, unknown> 的逆变兼容
  const execute = async (
    input: unknown,
    ctx:   ToolExecutionContext,
  ): Promise<unknown> => {
    return registry.callTool(serverName, info.serverToolName, input as Record<string, unknown>, ctx.signal);
  };

  return Object.freeze({
    id:                mcpToolId(serverName, info.serverToolName),
    name:              info.qualifiedName,
    description:       `[MCP:${serverName}] ${info.description}`,
    inputSchema:       inputZod,
    isReadOnly:        (_input: unknown) => false,
    isConcurrencySafe: (_input: unknown) => false,
    permissionMeta,
    descriptor,
    execute,
    unsafeExecute:     (raw: unknown, ctx: ToolExecutionContext) => execute(inputZod.parse(raw), ctx),
    parseInput:        (raw: unknown) => inputZod.parse(raw),
  });
}

/** 编码分隔符，避免 `a.b/c` 与 `a/b.c` 之类的 server/tool 组合产生同一个稳定 id。 */
function mcpToolId(serverName: string, serverToolName: string): string {
  return `mcp:${encodeURIComponent(serverName)}:${encodeURIComponent(serverToolName)}`;
}
