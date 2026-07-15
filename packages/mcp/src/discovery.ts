import type { Client }           from '@modelcontextprotocol/sdk/client/index.js';
import { z }                     from 'zod';
import type { BuiltTool, ToolDescriptor, ToolExecutionContext } from '@ema-agent/tools';
import type { ToolPermissionMeta } from '@ema-agent/permission';
import type { McpToolInfo }      from './types.js';
import { buildMcpToolName }      from './types.js';
import type { McpRegistry }      from './registry.js';

const MAX_DESCRIPTION_LEN = 2048;

// ── Tool discovery ────────────────────────────────────────────────────────────

/**
 * Fetch the tool list from a connected MCP server and return structured info.
 * Returns [] if the server has no tools capability or listing fails.
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
      originalServerName: serverName,   // preserved verbatim for connection lookup
      description:        desc.length > MAX_DESCRIPTION_LEN
        ? desc.slice(0, MAX_DESCRIPTION_LEN) + '… [truncated]'
        : desc,
      inputSchema:   (tool.inputSchema ?? { type: 'object', properties: {} }) as Record<string, unknown>,
      isReadOnly:    tool.annotations?.readOnlyHint    ?? false,
      isDestructive: tool.annotations?.destructiveHint ?? false,
    };
  });
}

// ── BuiltTool factory for MCP tools ──────────────────────────────────────────
//
// MCP tools can't use the standard buildTool() helper because their input
// schema comes from the server as JSON Schema, not as a Zod schema. We build
// the BuiltTool object directly so the LLM sees the real JSON Schema while
// the Zod validation stays permissive (validation is the server's job anyway).

export function buildMcpBuiltTool(
  info:     McpToolInfo,
  registry: McpRegistry,
): BuiltTool {
  // Use the original (non-sanitized) server name to look up the connection.
  // qualifiedName has hyphens/dots replaced with underscores; the connection
  // map is keyed by the original name, so splitting qualifiedName would break
  // any server whose name contains non-alphanumeric characters.
  const serverName = info.originalServerName;
  const inputZod      = z.record(z.unknown()); // permissive — MCP server validates

  const permissionMeta: ToolPermissionMeta = Object.freeze({
    riskLevel:  info.isDestructive ? 'high' : info.isReadOnly ? 'low' : 'medium',
    accessType: info.isReadOnly ? 'read' : 'execute',
  });

  const descriptor = (): ToolDescriptor => ({
    name:           info.qualifiedName,
    description:    `[MCP:${serverName}] ${info.description}`,
    inputJsonSchema: info.inputSchema,         // ← real MCP schema for the LLM
  });

  // execute takes `unknown` for contravariance compatibility with BuiltTool<unknown, unknown>
  const execute = async (
    input: unknown,
    ctx:   ToolExecutionContext,
  ): Promise<unknown> => {
    return registry.callTool(serverName, info.serverToolName, input as Record<string, unknown>, ctx.signal);
  };

  return Object.freeze({
    name:              info.qualifiedName,
    description:       `[MCP:${serverName}] ${info.description}`,
    inputSchema:       inputZod,
    isReadOnly:        (_input: unknown) => info.isReadOnly,
    isConcurrencySafe: (_input: unknown) => info.isReadOnly,
    permissionMeta,
    descriptor,
    execute,
    unsafeExecute:     (raw: unknown, ctx: ToolExecutionContext) => execute(inputZod.parse(raw), ctx),
    parseInput:        (raw: unknown) => inputZod.parse(raw),
  });
}
