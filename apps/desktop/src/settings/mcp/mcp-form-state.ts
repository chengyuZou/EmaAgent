// 负责 MCP 设置表单与后端服务器配置之间的无损双向转换。
import type { McpServerConfig } from '../../stores/mcp-store.js';

export type McpTransportType = 'stdio' | 'http';

export interface McpKeyValuePair {
  key: string;
  value: string;
}

export interface McpServerFormState {
  name: string;
  transport: McpTransportType;
  command: string;
  args: string[];
  url: string;
  env: McpKeyValuePair[];
  headers: McpKeyValuePair[];
}

export function createEmptyMcpFormState(): McpServerFormState {
  return {
    name: '',
    transport: 'stdio',
    command: '',
    args: [],
    url: '',
    env: [],
    headers: [],
  };
}

export function mcpPairsToRecord(
  pairs: McpKeyValuePair[],
): Record<string, string> | undefined {
  const result: Record<string, string> = {};
  for (const { key, value } of pairs) {
    if (key.trim()) result[key.trim()] = value;
  }
  return Object.keys(result).length > 0 ? result : undefined;
}

export function mcpRecordToPairs(
  record: Record<string, string> | undefined,
): McpKeyValuePair[] {
  return record
    ? Object.entries(record).map(([key, value]) => ({ key, value }))
    : [];
}

export function buildMcpServerConfig(form: McpServerFormState): McpServerConfig {
  if (form.transport === 'stdio') {
    return {
      type: 'stdio',
      command: form.command.trim(),
      // argv 的每个元素都有独立语义，空格、引号、反斜杠与空字符串均原样保留。
      args: [...form.args],
      env: mcpPairsToRecord(form.env),
    };
  }

  return {
    type: 'http',
    url: form.url.trim(),
    headers: mcpPairsToRecord(form.headers),
  };
}

export function mcpServerConfigToForm(
  name: string,
  config: McpServerConfig,
): McpServerFormState {
  if (config.type === 'stdio') {
    return {
      name,
      transport: 'stdio',
      command: config.command,
      args: [...(config.args ?? [])],
      url: '',
      env: mcpRecordToPairs(config.env),
      headers: [],
    };
  }

  return {
    name,
    transport: 'http',
    command: '',
    args: [],
    url: config.url,
    env: [],
    headers: mcpRecordToPairs(config.headers),
  };
}
