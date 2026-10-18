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

/** 工具数量或定义大小超限时整批拒绝, 避免注册不完整的工具列表. */
export class McpToolSchemaLimitError extends Error {
  constructor(serverName: string, detail: string) {
    super(`[MCP:${serverName}] Tool schema limit exceeded: ${detail}`);
    this.name = 'McpToolSchemaLimitError';
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

/** 连接期间发生断开或配置替换, 旧任务不能再保存连接和注册工具. */
export class McpConnectionSupersededError extends Error {
  constructor(serverName: string) {
    super(`MCP server "${serverName}" connection was superseded by a newer lifecycle operation`);
    this.name = 'McpConnectionSupersededError';
  }
}

/** SSE 地址不能直接当作 Streamable HTTP 地址使用, 需要用户提供对应端点. */
export class McpUnsupportedTransportError extends Error {
  constructor(serverName: string, transport: string) {
    super(
      `MCP server "${serverName}" uses unsupported transport "${transport}". ` +
      'Legacy SSE endpoints cannot be converted safely; configure a Streamable HTTP endpoint or stdio.',
    );
    this.name = 'McpUnsupportedTransportError';
  }
}
