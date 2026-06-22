import { McpServerConfigSchema } from './types.js';
import type { McpServerConfig } from './types.js';

// ── Config import / interop ───────────────────────────────────────────────────
//
// Users acquire MCP servers by copy-pasting JSON from mcp.so, Claude Desktop, or
// a README. Those shapes do NOT carry our `type` discriminator and are often
// nested under a `mcpServers` / `servers` map. This parser normalizes the common
// shapes into validated McpServerConfig[] so pasted configs "just work" instead
// of failing schema validation.
//
// Accepted inputs (any of):
//   { "mcpServers": { "<name>": { command, args, env } | { url, headers } } }   // Claude Desktop / mcp.so
//   { "servers":    { "<name>": { ... } } }                                     // VS Code
//   { "<name>":     { command|url, ... } }                                      // bare map
//   { command|url, ... }                                                        // single server (name optional)

export interface ImportedServer {
  name:   string;
  config: McpServerConfig;
}

export function parseImportedMcpServers(input: unknown, fallbackName = 'mcp-server'): ImportedServer[] {
  const root = coerceObject(input);
  if (!root) throw new Error('Invalid MCP config: expected a JSON object.');

  // Unwrap the common wrapper keys.
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

  // Maybe a bare map of name → server (heuristic: every value is an object with command|url).
  const entries = Object.entries(root);
  const looksLikeMap = entries.length > 0 && entries.every(([, v]) => {
    const o = coerceObject(v);
    return o !== null && ('command' in o || 'url' in o);
  });
  if (looksLikeMap) {
    return entries.map(([name, raw]) => ({ name, config: normalizeOne(raw, name) }));
  }

  // Single server object.
  const name = typeof root['name'] === 'string' ? root['name'] : fallbackName;
  return [{ name, config: normalizeOne(root, name) }];
}

// ── Normalize one raw server object into a validated McpServerConfig ───────────

function normalizeOne(raw: unknown, name: string): McpServerConfig {
  const o = coerceObject(raw);
  if (!o) throw new Error(`Invalid MCP server "${name}": expected an object.`);

  let candidate: Record<string, unknown>;

  if (typeof o['command'] === 'string') {
    candidate = {
      type:    'stdio',
      command: o['command'],
      args:    Array.isArray(o['args']) ? o['args'] : [],
      ...(isStringRecord(o['env']) ? { env: o['env'] } : {}),
      ...(typeof o['cwd'] === 'string' ? { cwd: o['cwd'] } : {}),
    };
  } else if (typeof o['url'] === 'string') {
    const explicit = o['type'];
    const url = o['url'];
    const type = explicit === 'sse' || explicit === 'http'
      ? explicit
      : url.toLowerCase().includes('/sse') ? 'sse' : 'http';   // infer: legacy SSE endpoints usually end in /sse
    candidate = {
      type,
      url,
      ...(isStringRecord(o['headers']) ? { headers: o['headers'] } : {}),
    };
  } else {
    throw new Error(`Invalid MCP server "${name}": needs a "command" (stdio) or "url" (sse/http).`);
  }

  const result = McpServerConfigSchema.safeParse(candidate);
  if (!result.success) {
    throw new Error(`Invalid MCP server "${name}": ${result.error.issues.map((i) => i.message).join('; ')}`);
  }
  return result.data;
}

// ── Helpers ────────────────────────────────────────────────────────────────────

function coerceObject(v: unknown): Record<string, unknown> | null {
  return v !== null && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
}

function isStringRecord(v: unknown): v is Record<string, string> {
  return coerceObject(v) !== null && Object.values(v as object).every((x) => typeof x === 'string');
}
