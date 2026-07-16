// 这里集中定义 MCP 连接、调用、超时、权限和协议迁移错误。
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

/** 连接期间发生了断开或配置替换，旧任务不得再提交连接和工具。 */
export class McpConnectionSupersededError extends Error {
  constructor(serverName: string) {
    super(`MCP server "${serverName}" connection was superseded by a newer lifecycle operation`);
    this.name = 'McpConnectionSupersededError';
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

/** 旧 SSE transport 已退出 MCP 当前协议，必须由用户提供新的 HTTP endpoint。 */
export class McpUnsupportedTransportError extends Error {
  constructor(serverName: string, transport: string) {
    super(
      `MCP server "${serverName}" uses unsupported transport "${transport}". ` +
      'Legacy SSE endpoints cannot be converted safely; configure a Streamable HTTP endpoint or stdio.',
    );
    this.name = 'McpUnsupportedTransportError';
  }
}
