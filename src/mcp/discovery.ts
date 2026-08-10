// 发现 MCP Server 暴露的工具，并把它们转换成 EmaAgent 的可注册工具。
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

// MCP 工具不需要任何宿主业务能力;单次调用身份与取消信号来自 ToolInvocation。
type McpToolContext = Record<string, never>;

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
  assertMcpToolSchemaLimits(serverName, result.tools);

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

// ── MCP 工具的 Tool 工厂 ───────────────────────────────────────────────────────
//
// 输入侧用宽松 Zod 保护对象边界,同时把 Server 的真实 JSON Schema 交给
// inputJsonSchemaOverride;结果侧由 execution.ts 统一限界与投影。

export function buildMcpBuiltTool(
  info:     McpToolInfo,
  registry: McpRegistry,
): Tool<Record<string, unknown>, McpToolOutput, McpToolContext> {
  // 用原始(未清洗)服务器名查连接。qualifiedName 的连字符/点已替换成下划线;
  // 连接 map 按原始名索引,故拆分 qualifiedName 会破坏名字含非字母数字的服务器。
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
    inputSchema:       z.record(z.unknown()),
    inputJsonSchemaOverride: info.inputSchema,
    // 远端自报 readOnly 只进 UI 展示;并发调度与 Permission 都不信任远端声明,
    // 一律按有副作用串行处理。
    isReadOnly:        () => false,
    isConcurrencySafe: () => false,
    getToolUseSummary: () => `${serverName} / ${info.serverToolName}`,
    // MCP annotations 只能提高风险,不能让远端 Server 自报安全后绕过询问。
    getPermissionIntent: () => ({
      riskLevel: info.reportedDestructive ? 'high' : 'medium',
      accessType: 'execute',
      promptPolicy: 'whenRequired',
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

/** 编码分隔符，避免 `a.b/c` 与 `a/b.c` 之类的 server/tool 组合产生同一个稳定 id。 */
function mcpToolId(serverName: string, serverToolName: string): string {
  return `mcp:${encodeURIComponent(serverName)}:${encodeURIComponent(serverToolName)}`;
}
