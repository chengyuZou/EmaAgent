import { z } from 'zod';
import { MAX_MCP_TOOLS_PER_SERVER } from './toolSchemaLimits.js';

/** 单次工具调用超时, 单位为秒. 未配置时使用 120 秒. */
const TOOL_TIMEOUT_SCHEMA = z.number().int().min(5).max(600).optional();

export const McpStdioConfigSchema = z.object({
  type:    z.literal('stdio').default('stdio'),
  command: z.string().min(1),
  args:    z.array(z.string()).default([]),
  env:     z.record(z.string(), z.string()).optional(),
  /**
   * 按名字读取宿主进程的环境变量, 避免把密钥值写入配置.
   * 合并顺序: SDK 默认 < envPassthrough < env.
   */
  envPassthrough: z.array(z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/)).max(32).optional(),
  /** 未配置时由子进程继承宿主的工作目录. */
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

export const McpInstallProvenanceSchema = z.discriminatedUnion('sourceKind', [
  z.object({ sourceKind: z.literal('manual') }),
  z.object({ sourceKind: z.literal('import') }),
  z.object({
    sourceKind: z.literal('official'),
    /** 市场条目的 externalId, 用于判断条目是否已经安装. */
    marketEntryId: z.string().min(1).max(500),
  }),
]);

export type McpInstallProvenance = z.infer<typeof McpInstallProvenanceSchema>;

export interface McpServerRecord {
  id:          string;
  name:        string;           // 用户可见别名
  provenance:  McpInstallProvenance;
  config:      McpServerConfig;
  /** 最近一次成功发现的工具, 用于启动时注册工具和离线时展示详情. */
  cachedTools?: McpToolInfo[];
  enabled:     boolean;
}

/** connected 表示握手和初次工具发现都已成功; disconnected 表示尚未连接或显式断开. */
export type McpConnectionStatus = 'connecting' | 'connected' | 'failed' | 'disconnected';

export const McpToolInfoSchema = z.object({
  /** 服务器上报的原始工具名, 如 "search". */
  serverToolName: z.string().min(1),
  /** 注册进 ToolRegistry 的名称, 如 "mcp__brave_search__search". */
  qualifiedName: z.string().min(1),
  /** 用户配置的原始服务器名, 不能从替换过字符的 qualifiedName 反推. */
  originalServerName: z.string().min(1),
  description: z.string(),
  inputSchema: z.record(z.string(), z.unknown()),
  /** 服务器自报的破坏性提示. 为 true 时要求用户批准. */
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

/** 设置列表返回工具数量, 展开详情时再读取工具定义. */
export interface McpServerSummary {
  name:              string;
  provenance:        McpInstallProvenance;
  config:            McpServerConfig;
  enabled:           boolean;
  connectionStatus:  McpConnectionStatus;
  connectionError?:  string;
  toolCount:          number;
}

/** tools 使用在线连接的工具列表, 离线时使用持久化缓存. */
export interface McpServerDetail extends McpServerSummary {
  tools: McpToolInfo[];
}

export interface McpProbeResult {
  ok: boolean;
  tools: McpToolInfo[];
  error?: string;
}

export function buildMcpToolName(serverName: string, toolName: string): string {
  const safe = (s: string) => s.replace(/[^a-zA-Z0-9]/g, '_');
  return `mcp__${safe(serverName)}__${safe(toolName)}`;
}
