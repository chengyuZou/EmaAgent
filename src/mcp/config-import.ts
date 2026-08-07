// 这里把常见 MCP JSON 配置归一化为 Ema 支持的 stdio 或 Streamable HTTP 配置。
import { McpServerConfigSchema } from './types.js';
import type { McpServerConfig } from './types.js';
import { McpUnsupportedTransportError } from './errors.js';

// ── 配置导入 / 互操作 ───────────────────────────────────────────────────────────
//
// 用户从 mcp.so、Claude Desktop 或 README 复制粘贴 JSON 获取 MCP 服务器。
// 这些形态不带我们的 `type` 判别字段,且常嵌在 `mcpServers` / `servers` map 下。
// 本解析器把常见形态归一化成已校验的 McpServerConfig[],让粘贴的配置"直接能用",
// 而非校验失败。
//
// 接受输入(任一):
//   { "mcpServers": { "<name>": { command, args, env } | { url, headers } } }   // Claude Desktop / mcp.so
//   { "servers":    { "<name>": { ... } } }                                     // VS Code
//   { "<name>":     { command|url, ... } }                                      // 裸 map
//   { command|url, ... }                                                        // 单服务器(name 可选)

export interface ImportedServer {
  name:   string;
  config: McpServerConfig;
}

export function parseImportedMcpServers(input: unknown, fallbackName = 'mcp-server'): ImportedServer[] {
  // 裸 URL 粘贴(ModelScope Remote 页签复制出来的形态)直接归为单条 http server。
  if (typeof input === 'string') {
    const url = input.trim();
    if (/^https?:\/\//.test(url)) {
      return [{ name: fallbackName, config: McpServerConfigSchema.parse({ type: 'http', url }) }];
    }
    throw new Error('Invalid MCP config: expected a JSON object or an http(s) URL.');
  }

  const root = coerceObject(input);
  if (!root) throw new Error('Invalid MCP config: expected a JSON object.');

  // 解开常见包装键。
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

  // 可能是 name -> server 的裸 map(启发式:每个值都是带 command|url 的对象)。
  const entries = Object.entries(root);
  const looksLikeMap = entries.length > 0 && entries.every(([, v]) => {
    const o = coerceObject(v);
    return o !== null && ('command' in o || 'url' in o);
  });
  if (looksLikeMap) {
    return entries.map(([name, raw]) => ({ name, config: normalizeOne(raw, name) }));
  }

  // 单服务器对象。
  const name = typeof root['name'] === 'string' ? root['name'] : fallbackName;
  return [{ name, config: normalizeOne(root, name) }];
}

// ── 把一个裸服务器对象归一化成已校验的 McpServerConfig ───

function normalizeOne(raw: unknown, name: string): McpServerConfig {
  const o = coerceObject(raw);
  if (!o) throw new Error(`Invalid MCP server "${name}": expected an object.`);

  // 判别键兼容:Claude Desktop/mcp.so 用 type,ModelScope/AstrBot 用 transport。
  // 取值统一成小写连字符形(streamable_http → streamable-http)。
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
      ...(typeof o['cwd'] === 'string' ? { cwd: o['cwd'] } : {}),
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

// ── 辅助函数 ────────────────────────────────────────────────────────────────────

function coerceObject(v: unknown): Record<string, unknown> | null {
  return v !== null && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
}

function isStringRecord(v: unknown): v is Record<string, string> {
  return coerceObject(v) !== null && Object.values(v as object).every((x) => typeof x === 'string');
}
