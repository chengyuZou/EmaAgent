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
