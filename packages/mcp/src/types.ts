import { z } from 'zod';

// ── 服务器配置 ──────────────────────────────────────────────────────────────
//
// V1 支持三种传输类型,覆盖 mcp.so 上绝大多数服务器:
//   stdio   - 拉起本地子进程(npx、uvx、node、python 等)
//   sse     - 连远程 SSE 端点(旧式 HTTP 流)
//   http    - 连远程 HTTP 端点(现代 MCP 协议)

export const McpStdioConfigSchema = z.object({
  type:    z.literal('stdio').default('stdio'),
  command: z.string().min(1),
  args:    z.array(z.string()).default([]),
  env:     z.record(z.string(), z.string()).optional(),
  /** 拉起的子进程的工作目录。部分服务器需要。 */
  cwd:     z.string().optional(),
});

// 'sse' 用旧式 SSEClientTransport(MCP SDK ≥1.x 已弃用)。
// mcp.so 上很多服务器(智谱、百度等)仍发布 SSE 端点。
// 服务器支持时,新注册服务器仍优先用 'http'。
export const McpSseConfigSchema = z.object({
  type:    z.literal('sse'),
  url:     z.string().url(),
  headers: z.record(z.string(), z.string()).optional(),
});

export const McpHttpConfigSchema = z.object({
  type:    z.literal('http'),
  url:     z.string().url(),
  headers: z.record(z.string(), z.string()).optional(),
});

export const McpServerConfigSchema = z.discriminatedUnion('type', [
  McpStdioConfigSchema,
  McpSseConfigSchema,
  McpHttpConfigSchema,
]);

export type McpStdioConfig  = z.infer<typeof McpStdioConfigSchema>;
export type McpSseConfig    = z.infer<typeof McpSseConfigSchema>;
export type McpHttpConfig   = z.infer<typeof McpHttpConfigSchema>;
export type McpServerConfig = z.infer<typeof McpServerConfigSchema>;

/** 一次 stdio 子进程启动的完整、不可变授权意图。 */
export interface McpStdioLaunchIntent {
  readonly operation: 'connect' | 'probe';
  readonly serverName: string;
  readonly command: string;
  readonly args: readonly string[];
  readonly cwd?: string;
  /** 仅供授权适配器做脱敏展示;执行仍使用同一份冻结配置中的真实值。 */
  readonly environment?: Readonly<Record<string, string>>;
}

// ── 持久化服务器记录 ───────────────────────────────────────────────────────────

export interface McpServerRecord {
  id:          string;
  name:        string;           // 用户可见别名
  sourceUrl?:  string;           // mcp.so 页面 URL(可选)
  config:      McpServerConfig;  // 解析后的传输配置
  /** 最近一次成功 listTools 的工具 - 启动时不连接即可 priming 注册表,
   *  并在服务器离线时展示工具。 */
  cachedTools?: McpToolInfo[];
  cachedAt:    number;           // 毫秒;0 = 从未缓存
  enabled:     boolean;
  installedAt: number;
}

// ── 连接状态机 ──────────────────────────────────────────────────────────────────
//
// connected    - SDK Client 开着,工具已发现
// connecting   - 进行中(异步 connect)
// failed       - connect 抛错或超时
// disconnected - 显式停止,或尚未启动

export type McpConnectionStatus = 'connecting' | 'connected' | 'failed' | 'disconnected';

export interface McpToolInfo {
  /** 服务器上报的未限定工具名,如 "search"。 */
  serverToolName:     string;
  /** 注册进 ToolRegistry 的限定名,如 "mcp__brave_search__search"。 */
  qualifiedName:      string;
  /**
   * 用户配置的原始服务器名,如 "brave-search"。
   * 用作 McpRegistry.connections 的键 - 不可清洗。
   * 与 qualifiedName 分开,因 buildMcpToolName() 把连字符/点/空格替换成
   * 下划线作 LLM 可见标识,但连接 map 按原始名索引。
   */
  originalServerName: string;
  description:        string;
  inputSchema:        Record<string, unknown>;
  isReadOnly:         boolean;
  isDestructive:      boolean;
}

export interface McpConnection {
  serverName: string;
  status:     McpConnectionStatus;
  tools:      McpToolInfo[];
  error?:     string;
  connectedAt?: number;
}

export interface McpProbeResult {
  ok: boolean;
  tools: McpToolInfo[];
  error?: string;
}

// ── 工具命名 ───────────────────────────────────────────────────────────────

export function buildMcpToolName(serverName: string, toolName: string): string {
  // 清洗:非字母数字替换成下划线
  const safe = (s: string) => s.replace(/[^a-zA-Z0-9]/g, '_');
  return `mcp__${safe(serverName)}__${safe(toolName)}`;
}
