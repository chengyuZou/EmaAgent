// 把 Registry 条目落成一条 MCP server 记录:补全必填输入、组装配置、写溯源。
import type { McpInstallProvenance, McpServerConfig } from '../types.js';
import type { McpRegistryEntry, McpRegistrySource } from './types.js';

/** 安装落库只依赖 register;McpServerStore 与 McpRegistry 的 register 同签名。 */
export interface McpServerRegistrationPort {
  register(
    name: string,
    config: McpServerConfig,
    sourceUrl?: string,
    provenance?: McpInstallProvenance,
  ): string;
}

export interface InstallRegistryEntryInput {
  store:  McpServerRegistrationPort;
  source: McpRegistrySource;
  entry:  McpRegistryEntry;
  /** 用户可见别名;缺省取条目标题,再退化为 name 末段。 */
  name?:  string;
  /** requiredInputs 的用户值,key 对应 env 变量名或 header 名。 */
  inputs?: Record<string, string>;
}

/** 安装成功返回 server 记录 id;同名 server 会被更新(register 语义)。 */
export function installRegistryEntry(input: InstallRegistryEntryInput): string {
  const { store, source, entry } = input;
  if (!entry.installable || !entry.spec) {
    throw new Error(`MCP 条目 ${entry.name} 不可安装: ${entry.unavailableReason ?? '无安装规格'}`);
  }

  const userInputs = input.inputs ?? {};
  const missing = (entry.requiredInputs ?? [])
    .filter((required) => !userInputs[required.key]?.trim())
    .map((required) => required.key);
  if (missing.length > 0) {
    throw new Error(`MCP 条目 ${entry.name} 缺少必填输入: ${missing.join(', ')}`);
  }

  let config: McpServerConfig;
  if (entry.spec.transport === 'http') {
    const headers = { ...entry.spec.headers };
    for (const required of entry.requiredInputs ?? []) {
      if (required.target === 'header') headers[required.key] = userInputs[required.key]!;
    }
    config = {
      type: 'http',
      url: entry.spec.url,
      ...(Object.keys(headers).length > 0 ? { headers } : {}),
    };
  } else {
    const env = { ...entry.spec.env };
    for (const required of entry.requiredInputs ?? []) {
      if (required.target === 'env') env[required.key] = userInputs[required.key]!;
    }
    config = {
      type: 'stdio',
      command: entry.spec.command,
      args: [...entry.spec.args],
      ...(Object.keys(env).length > 0 ? { env } : {}),
    };
  }

  return store.register(
    input.name?.trim() || entry.title || entry.name.split('/').at(-1)!,
    config,
    entry.websiteUrl ?? entry.repositoryUrl,
    {
      sourceKind: 'registry',
      registrySourceId: source.id,
      registryEntryId: entry.name,
      registryVersion: entry.version,
    },
  );
}
