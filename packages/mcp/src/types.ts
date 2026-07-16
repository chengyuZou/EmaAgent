// 这里定义 MCP 服务器配置、工具发现结果、连接状态和公开 Schema。
import { z } from 'zod';

// ── 服务器配置 ──────────────────────────────────────────────────────────────
//
// V1 只支持当前 MCP 协议使用的两种传输:
//   stdio   - 拉起本地子进程(npx、uvx、node、python 等)
//   http    - 连接 Streamable HTTP 端点

export const McpStdioConfigSchema = z.object({
  type:    z.literal('stdio').default('stdio'),
  command: z.string().min(1),
  args:    z.array(z.string()).default([]),
  env:     z.record(z.string(), z.string()).optional(),
  /** 拉起的子进程的工作目录。部分服务器需要。 */
  cwd:     z.string().optional(),
});

export const McpHttpConfigSchema = z.object({
  type:    z.literal('http'),
  url:     z.string().url(),
  headers: z.record(z.string(), z.string()).optional(),
});

export const McpServerConfigSchema = z.discriminatedUnion('type', [
  McpStdioConfigSchema,
  McpHttpConfigSchema,
]);

export type McpStdioConfig  = z.infer<typeof McpStdioConfigSchema>;
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

export const McpToolInfoSchema = z.preprocess((value) => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return value;
  const raw = value as Record<string, unknown>;
  return {
    ...raw,
    // 兼容旧缓存字段；迁移后仍只是远端提示，绝不恢复为安全事实。
    reportedReadOnly: raw.reportedReadOnly ?? raw.isReadOnly ?? false,
    reportedDestructive: raw.reportedDestructive ?? raw.isDestructive ?? false,
  };
}, z.object({
  /** 服务器上报的未限定工具名,如 "search"。 */
  serverToolName: z.string().min(1),
  /** 注册进 ToolRegistry 的限定名,如 "mcp__brave_search__search"。 */
  qualifiedName: z.string().min(1),
  /** 用户配置的原始服务器名,不可从清洗后的 qualifiedName 反推。 */
  originalServerName: z.string().min(1),
  description: z.string(),
  inputSchema: z.record(z.unknown()),
  /** 远端 Server 自报的只读提示，只能展示，不能降低本地风险等级。 */
  reportedReadOnly: z.boolean().default(false),
  /** 远端 Server 自报的破坏性提示，可以单向提升本地风险等级。 */
  reportedDestructive: z.boolean().default(false),
}));

export const McpToolInfoListSchema = z.array(McpToolInfoSchema).max(1_000);
export type McpToolInfo = z.infer<typeof McpToolInfoSchema>;

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
