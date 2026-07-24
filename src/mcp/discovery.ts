// 发现 MCP Server 暴露的工具，并把它们转换成 EmaAgent 的可注册工具。
import type { Client }           from '@modelcontextprotocol/sdk/client/index.js';
import { z }                     from 'zod';
import { buildTool } from '@ema-agent/tools';
import type { BuiltTool } from '@ema-agent/tools';
import type { ToolPermissionMeta } from '@ema-agent/permission';
import type { McpToolInfo }      from './types.js';
import { buildMcpToolName }      from './types.js';
import type { McpRegistry }      from './registry.js';

const MAX_DESCRIPTION_LEN = 2048;

interface McpToolHostContext {
  readonly signal: AbortSignal;
}

interface McpToolContext {
  readonly signal: AbortSignal;
}

// ── 工具发现 ────────────────────────────────────────────────────────────────────

/**
 * 从已连接的 MCP 服务器拉取工具列表,返回结构化信息。
 * 服务器无 tools 能力或拉取失败时返回 []。
 */
export async function discoverServerTools(
  serverName: string,
  client:     Client,
  signal?:    AbortSignal,
): Promise<McpToolInfo[]> {
  // listTools 失败必须上抛给连接状态机；只有 Server 真正返回空数组才算成功。
  const result = await client.listTools(undefined, { signal });

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
// MCP 使用宽松 Zod 保护对象边界，同时把 Server 的真实 JSON Schema 直接交给
// buildTool；结果预算和其他保守默认值因此不会绕过统一 Tool 契约。

export function buildMcpBuiltTool(
  info:     McpToolInfo,
  registry: McpRegistry,
): BuiltTool<Record<string, unknown>, unknown, McpToolContext> {
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

  return buildTool<
    Record<string, unknown>,
    unknown,
    McpToolHostContext,
    McpToolContext
  >({
    id:                mcpToolId(serverName, info.serverToolName),
    name:              info.qualifiedName,
    origin: {
      kind: 'mcp',
      serverName,
      serverToolName: info.serverToolName,
    },
    description:       `[MCP:${serverName}] ${info.description}`,
    inputSchema:       inputZod,
    inputJsonSchemaOverride: info.inputSchema,
    isReadOnly:        () => false,
    isConcurrencySafe: () => false,
    permissionMeta,
    validateContext: (context) => ({
      valid: true,
      context: { signal: context.signal },
    }),
    execute: (input, context) => registry.callTool(
      serverName,
      info.serverToolName,
      input,
      context.signal,
    ),
  });
}

/** 编码分隔符，避免 `a.b/c` 与 `a/b.c` 之类的 server/tool 组合产生同一个稳定 id。 */
function mcpToolId(serverName: string, serverToolName: string): string {
  return `mcp:${encodeURIComponent(serverName)}:${encodeURIComponent(serverToolName)}`;
}
