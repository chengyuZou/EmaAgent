export class McpConnectionError extends Error {
  constructor(serverName: string, message: string) {
    super(`[MCP:${serverName}] Connection failed: ${message}`);
    this.name = 'McpConnectionError';
  }
}

export class McpToolCallError extends Error {
  constructor(serverName: string, toolName: string, message: string) {
    super(`[MCP:${serverName}/${toolName}] Tool call failed: ${message}`);
    this.name = 'McpToolCallError';
  }
}

export class McpTimeoutError extends Error {
  constructor(serverName: string, operation: string, ms: number) {
    super(`[MCP:${serverName}] ${operation} timed out after ${ms}ms`);
    this.name = 'McpTimeoutError';
  }
}

export class McpServerNotFoundError extends Error {
  constructor(serverName: string) {
    super(`MCP server "${serverName}" is not registered`);
    this.name = 'McpServerNotFoundError';
  }
}

export class McpStdioPermissionError extends Error {
  constructor(
    public readonly operation: 'connect' | 'probe',
    public readonly serverName: string,
    reason: 'gate_unavailable' | 'denied',
  ) {
    super(
      reason === 'gate_unavailable'
        ? `MCP stdio ${operation} for "${serverName}" is disabled because no permission gate is configured`
        : `MCP stdio ${operation} for "${serverName}" was denied by the permission system`,
    );
    this.name = 'McpStdioPermissionError';
  }
}
