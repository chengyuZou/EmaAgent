// MCP Registry 目录源与可安装条目的领域类型。
import { z } from 'zod';

// ── 目录源(SQL 行的领域投影)────────────────────────────────────────────────

export interface McpRegistrySource {
  id:          string;
  label:       string;
  registryUrl: string;
  enabled:     boolean;
  builtin:     boolean;
  sortOrder:   number;
  createdAt:   number;
  updatedAt:   number;
}

// ── Registry 条目(浏览/UI 用)─────────────────────────────────────────────────

/**
 * 条目的安装规格:remote 直连或锁定 stdio 启动。
 * stdio 的 args 已含精确版本锁定(npx -y pkg@version / uvx pkg==version)。
 */
export type McpInstallSpec =
  | {
      transport: 'http';
      url: string;
      headers?: Record<string, string>;
    }
  | {
      transport: 'stdio';
      command: string;
      args: readonly string[];
      env?: Record<string, string>;
    };

/** 安装时必须由用户补全的输入(server 需要的密钥/参数)。 */
export interface McpRequiredInput {
  /** env 变量名或 header 名。 */
  key:         string;
  target:      'env' | 'header';
  isSecret:    boolean;
  description?: string;
}

export interface McpRegistryEntry {
  /** Registry 稳定身份,如 "ac.inference.sh/mcp"。 */
  name:        string;
  title?:      string;
  description?: string;
  version:     string;
  repositoryUrl?: string;
  websiteUrl?: string;
  installable: boolean;
  /** 不可安装时的用户可读原因(仅 SSE、模板参数、无精确版本等)。 */
  unavailableReason?: string;
  spec?:           McpInstallSpec;
  requiredInputs?: readonly McpRequiredInput[];
}

// ── Registry wire 解析(宽进严出,未知字段剥离)─────────────────────────────────
//
// 官方 schema 经历过 camelCase/snake_case 两代字段名,两类都收。

export const RawRegistryRemoteSchema = z.object({
  type: z.string(),
  url:  z.string().min(1),
  headers: z.array(z.object({
    name:  z.string().min(1),
    value: z.string().optional(),
    is_secret:   z.boolean().optional(),
    is_required: z.boolean().optional(),
    description: z.string().optional(),
  }).passthrough()).optional(),
}).passthrough();

export const RawRegistryArgumentSchema = z.object({
  type:  z.enum(['positional', 'named']),
  name:  z.string().optional(),
  value: z.string().optional(),
  value_hint: z.string().optional(),
  description: z.string().optional(),
  is_required: z.boolean().optional(),
}).passthrough();

export const RawRegistryEnvVarSchema = z.object({
  name:  z.string().min(1),
  description: z.string().optional(),
  is_secret:   z.boolean().optional(),
  is_required: z.boolean().optional(),
  default:     z.string().optional(),
}).passthrough();

export const RawRegistryPackageSchema = z.object({
  registryType:   z.string().optional(),
  registry_type:  z.string().optional(),
  registry_name:  z.string().optional(),
  identifier:     z.string().optional(),
  name:           z.string().optional(),
  version:        z.string().optional(),
  runtime_arguments: z.array(RawRegistryArgumentSchema).optional(),
  package_arguments: z.array(RawRegistryArgumentSchema).optional(),
  environment_variables: z.array(RawRegistryEnvVarSchema).optional(),
}).passthrough();

export const RawRegistryServerSchema = z.object({
  name:        z.string().min(1),
  title:       z.string().optional(),
  description: z.string().optional(),
  version:     z.string().min(1),
  repository:  z.object({ url: z.string() }).passthrough().optional(),
  websiteUrl:  z.string().optional(),
  website_url: z.string().optional(),
  remotes:  z.array(RawRegistryRemoteSchema).optional(),
  packages: z.array(RawRegistryPackageSchema).optional(),
}).passthrough();

export type RawRegistryRemote  = z.infer<typeof RawRegistryRemoteSchema>;
export type RawRegistryArgument = z.infer<typeof RawRegistryArgumentSchema>;
export type RawRegistryEnvVar  = z.infer<typeof RawRegistryEnvVarSchema>;
export type RawRegistryPackage = z.infer<typeof RawRegistryPackageSchema>;
export type RawRegistryServer  = z.infer<typeof RawRegistryServerSchema>;
