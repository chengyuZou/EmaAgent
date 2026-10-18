import { McpServerConfigSchema } from './types.js';
import type { McpServerConfig } from './types.js';
import { McpUnsupportedTransportError } from './errors.js';

export interface ImportedServer {
  name:   string;
  config: McpServerConfig;
}

export function parseImportedMcpServers(input: unknown, fallbackName = 'mcp-server'): ImportedServer[] {
  if (typeof input === 'string') {
    throw new Error('Invalid MCP config: expected a JSON object.');
  }

  const root = coerceObject(input);
  if (!root) throw new Error('Invalid MCP config: expected a JSON object.');

  const map =
    coerceObject(root['mcpServers']) ??
    coerceObject(root['servers']) ??
    null;

  if (map) {
    const out: ImportedServer[] = [];
    for (const [name, raw] of Object.entries(map)) {
      out.push({ name, config: normalizeOne(raw, name) });
    }
    if (out.length === 0) throw new Error('Invalid MCP config: no servers found.');
    return out;
  }

  // 没有包装键时, 只有所有值都是服务器配置才按名字映射处理.
  const entries = Object.entries(root);
  const looksLikeMap = entries.length > 0 && entries.every(([, v]) => {
    const o = coerceObject(v);
    return o !== null && ('command' in o || 'url' in o);
  });
  if (looksLikeMap) {
    return entries.map(([name, raw]) => ({ name, config: normalizeOne(raw, name) }));
  }

  const name = typeof root['name'] === 'string' ? root['name'] : fallbackName;
  return [{ name, config: normalizeOne(root, name) }];
}

function normalizeOne(raw: unknown, name: string): McpServerConfig {
  const o = coerceObject(raw);
  if (!o) throw new Error(`Invalid MCP server "${name}": expected an object.`);

  // 导入配置可能使用 type 或 transport, 同时接受 streamable_http 和 streamable-http.
  const rawDiscriminator = o['type'] ?? o['transport'];
  const explicit = typeof rawDiscriminator === 'string'
    ? rawDiscriminator.toLowerCase().replace(/_/g, '-')
    : undefined;

  let candidate: Record<string, unknown>;

  if (typeof o['command'] === 'string') {
    if (explicit !== undefined && explicit !== 'stdio') {
      throw new Error(`Invalid MCP server "${name}": transport "${rawDiscriminator}" conflicts with "command".`);
    }
    candidate = {
      type:    'stdio',
      command: o['command'],
      args:    Array.isArray(o['args']) ? o['args'] : [],
      ...(isStringRecord(o['env']) ? { env: o['env'] } : {}),
      ...(Array.isArray(o['envPassthrough']) && o['envPassthrough'].every(value => typeof value === 'string')
        ? { envPassthrough: o['envPassthrough'] }
        : {}),
      ...(typeof o['cwd'] === 'string' ? { cwd: o['cwd'] } : {}),
      ...(typeof o['toolTimeoutSec'] === 'number' ? { toolTimeoutSec: o['toolTimeoutSec'] } : {}),
    };
  } else if (typeof o['url'] === 'string') {
    const url = o['url'];
    if (explicit === 'sse' || (explicit === undefined && looksLikeLegacySseEndpoint(url))) {
      throw new McpUnsupportedTransportError(name, 'sse');
    }
    if (explicit !== undefined && explicit !== 'http' && explicit !== 'streamable-http') {
      throw new Error(`Invalid MCP server "${name}": unsupported transport "${rawDiscriminator}".`);
    }
    candidate = {
      type: 'http',
      url,
      ...(isStringRecord(o['headers']) ? { headers: o['headers'] } : {}),
      ...(typeof o['toolTimeoutSec'] === 'number' ? { toolTimeoutSec: o['toolTimeoutSec'] } : {}),
    };
  } else {
    throw new Error(`Invalid MCP server "${name}": needs a "command" (stdio) or Streamable HTTP "url".`);
  }

  const result = McpServerConfigSchema.safeParse(candidate);
  if (!result.success) {
    throw new Error(`Invalid MCP server "${name}": ${result.error.issues.map((i) => i.message).join('; ')}`);
  }
  return result.data;
}

function looksLikeLegacySseEndpoint(value: string): boolean {
  try {
    const pathname = new URL(value).pathname.replace(/\/+$/, '').toLowerCase();
    return pathname.endsWith('/sse');
  } catch {
    return false;
  }
}

function coerceObject(v: unknown): Record<string, unknown> | null {
  return v !== null && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
}

function isStringRecord(v: unknown): v is Record<string, string> {
  return coerceObject(v) !== null && Object.values(v as object).every((x) => typeof x === 'string');
}
