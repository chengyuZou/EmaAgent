import { z } from 'zod';
import { buildTool } from '@ema-agent/tool';
import type { ToolExecutionContext, IMcpClientBridge } from '@ema-agent/tool';

// ── Input schema ──────────────────────────────────────────────────────────────

const inputSchema = z.object({
  server: z.string().min(1).describe('MCP server name as configured in settings.'),
  tool: z.string().min(1).describe('Tool name on the MCP server.'),
  args: z.record(z.unknown()).default({}).describe('Arguments to pass to the MCP tool.'),
});

type McpCallInput = z.infer<typeof inputSchema>;

// ── Output type ───────────────────────────────────────────────────────────────

export interface McpCallResult {
  server: string;
  tool: string;
  result: unknown;
}

// ── Tool definition ───────────────────────────────────────────────────────────

export const mcpCallTool = buildTool<McpCallInput, McpCallResult>({
  name: 'mcp_call',
  description: `Call a tool on a configured MCP (Model Context Protocol) server.

The MCP server must be configured in settings before use. Arguments are passed through verbatim.`,

  inputSchema,
  isReadOnly: () => false,
  isConcurrencySafe: () => true,

  permissionMeta: {
    riskLevel: 'medium',
    accessType: 'execute',
  },

  async execute(input: McpCallInput, ctx: ToolExecutionContext): Promise<McpCallResult> {
    const mcpClient: IMcpClientBridge | undefined = ctx.mcpClient;
    if (!mcpClient) {
      throw new Error(
        'MCP client bridge is not configured. Ensure an MCP server is connected before using mcp_call.',
      );
    }

    const result = await mcpClient.call(input.server, input.tool, input.args);
    return { server: input.server, tool: input.tool, result };
  },
});
