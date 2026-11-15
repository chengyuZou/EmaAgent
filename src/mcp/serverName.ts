/** 允许的 MCP 服务器名字符集, 保证 URL 路径参数和模型工具名前缀安全无冲突. */
export const MCP_SERVER_NAME_RE = /^[a-zA-Z0-9_-]{1,100}$/;

/** 将来自外部注册表或 JSON 的原始名称清洗为允许的服务器名字符集. */
export function sanitizeMcpServerName(value: string): string {
  return value.replace(/[^a-zA-Z0-9_-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 100) || 'mcp-server';
}
