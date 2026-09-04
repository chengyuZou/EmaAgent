import { z } from 'zod';
import { MAX_MCP_TOOLS_PER_SERVER } from './toolSchemaLimits.js';

// ── 服务器配置 ──────────────────────────────────────────────────────────────
//
// V1 只支持当前 MCP 协议使用的两种传输:
//   stdio   - 拉起本地子进程(npx、uvx、node、python 等)
//   http    - 连接 Streamable HTTP 端点

/** 单次工具调用超时(秒),缺省 120;浏览器自动化等长任务 server 可单独放宽。 */
const TOOL_TIMEOUT_SCHEMA = z.number().int().min(5).max(600).optional();

export const McpStdioConfigSchema = z.object({
  type:    z.literal('stdio').default('stdio'),
  command: z.string().min(1),
  args:    z.array(z.string()).default([]),
  env:     z.record(z.string(), z.string()).optional(),
  /**
   * 按名字白名单透传宿主进程环境变量(如 GITHUB_TOKEN),
   * 免把密钥值写进 env;合并顺序:SDK 默认 < 透传 < 用户 env。
   */
  envPassthrough: z.array(z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/)).max(32).optional(),
  /** 拉起的子进程的工作目录。部分服务器需要。 */
  cwd:     z.string().optional(),
  toolTimeoutSec: TOOL_TIMEOUT_SCHEMA,
});

export const McpHttpConfigSchema = z.object({
  type:    z.literal('http'),
  url:     z.url(),
  headers: z.record(z.string(), z.string()).optional(),
  toolTimeoutSec: TOOL_TIMEOUT_SCHEMA,
});

export const McpServerConfigSchema = z.discriminatedUnion('type', [
  McpStdioConfigSchema,
  McpHttpConfigSchema,
]);

export type McpStdioConfig  = z.infer<typeof McpStdioConfigSchema>;
export type McpHttpConfig   = z.infer<typeof McpHttpConfigSchema>;
export type McpServerConfig = z.infer<typeof McpServerConfigSchema>;

// ── 安装溯源 ─────────────────────────────────────────────────────────────────
//
// 只回答"这条 server 记录当初从哪来". Official 的 marketEntryId
// 供市场页判断条目是否已经添加,不参与连接身份。

export const McpInstallProvenanceSchema = z.discriminatedUnion('sourceKind', [
  z.object({ sourceKind: z.literal('manual') }),
  z.object({ sourceKind: z.literal('import') }),
  z.object({
    sourceKind: z.literal('official'),
    marketEntryId: z.string().min(1).max(500),
  }),
]);

export type McpInstallProvenance = z.infer<typeof McpInstallProvenanceSchema>;

// ── 持久化服务器记录 ───────────────────────────────────────────────────────────

export interface McpServerRecord {
  id:          string;
  name:        string;           // 用户可见别名
  provenance:  McpInstallProvenance;
  config:      McpServerConfig;  // 解析后的传输配置(明文 domain 形式)
  /** 最近一次成功 listTools 的工具 - 启动时不连接即可 priming 注册表,
   *  并在服务器离线时展示工具。 */
  cachedTools?: McpToolInfo[];
  enabled:     boolean;
}

// ── 连接状态机 ──────────────────────────────────────────────────────────────────
//
// connected    - SDK Client 开着,工具已发现
// connecting   - 进行中(异步 connect)
// failed       - connect 抛错或超时
// disconnected - 显式停止,或尚未启动

export type McpConnectionStatus = 'connecting' | 'connected' | 'failed' | 'disconnected';

export const McpToolInfoSchema = z.object({
  /** 服务器上报的未限定工具名,如 "search"。 */
  serverToolName: z.string().min(1),
  /** 注册进 ToolRegistry 的限定名,如 "mcp__brave_search__search"。 */
  qualifiedName: z.string().min(1),
  /** 用户配置的原始服务器名,不可从清洗后的 qualifiedName 反推。 */
  originalServerName: z.string().min(1),
  description: z.string(),
  inputSchema: z.record(z.string(), z.unknown()),
  /** 远端 Server 自报的只读提示,仅供 UI 展示;并发调度与权限都不信任它。 */
  reportedReadOnly: z.boolean().default(false),
  /** 远端 Server 自报的破坏性提示,可以单向提升本地风险等级。 */
  reportedDestructive: z.boolean().default(false),
});

export const McpToolInfoListSchema = z.array(McpToolInfoSchema).max(MAX_MCP_TOOLS_PER_SERVER);
export type McpToolInfo = z.infer<typeof McpToolInfoSchema>;

export interface McpConnection {
  serverName: string;
  status:     McpConnectionStatus;
  tools:      McpToolInfo[];
  error?:     string;
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
