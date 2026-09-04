import { z } from 'zod';
import type { McpServerConfig } from '../types.js';
import type { McpMarketCatalog, McpMarketCatalogPage, McpMarketEntry, McpMarketEntryDetail, McpMarketInstallInput } from './types.js';

const BASE_URL = 'https://registry.modelcontextprotocol.io/v0.1/servers';
const PAGE_SIZE = 100;
const REQUEST_TIMEOUT_MS = 10_000;

const ServerSchema = z.object({
  name: z.string().min(1),
  title: z.string().optional(),
  description: z.string().optional(),
  version: z.string().optional(),
  repository: z.object({ url: z.url().optional() }).loose().optional(),
  websiteUrl: z.url().optional(),
  remotes: z.array(z.object({
    type: z.string(),
    url: z.url(),
    headers: z.array(z.object({
      name: z.string(),
      value: z.string().optional(),
      isSecret: z.boolean().optional(),
      isRequired: z.boolean().optional(),
      description: z.string().optional(),
    }).loose()).optional(),
  }).loose()).optional(),
  packages: z.array(z.object({
    registryType: z.string().optional(),
    identifier: z.string().optional(),
    name: z.string().optional(),
    version: z.string().optional(),
    runtimeArguments: z.array(z.object({ type: z.string(), name: z.string().optional(), value: z.string().optional() }).loose()).optional(),
    packageArguments: z.array(z.object({ type: z.string(), name: z.string().optional(), value: z.string().optional() }).loose()).optional(),
    environmentVariables: z.array(z.object({
      name: z.string(),
      default: z.string().optional(),
      isSecret: z.boolean().optional(),
      isRequired: z.boolean().optional(),
      description: z.string().optional(),
    }).loose()).optional(),
  }).loose()).optional(),
}).loose();

type Server = z.infer<typeof ServerSchema>;

export class OfficialRegistryAdapter implements McpMarketCatalog {
  readonly source = 'official' as const;

  async page(cursor?: string, signal?: AbortSignal): Promise<McpMarketCatalogPage> {
    const url = new URL(BASE_URL);
    url.searchParams.set('limit', String(PAGE_SIZE));
    url.searchParams.set('version', 'latest');
    if (cursor) url.searchParams.set('cursor', cursor);
    const body = await fetchJson(url.toString(), signal);
    const page = pageOf(body);
    const items: McpMarketEntry[] = [];
    for (const value of page.servers) {
      const parsed = ServerSchema.safeParse(value);
      if (parsed.success) items.push(summary(parsed.data));
    }
    return { items, nextCursor: page.nextCursor ?? null };
  }

  async detail(externalId: string, signal?: AbortSignal): Promise<McpMarketEntryDetail | null> {
    const url = `${BASE_URL}/${encodeURIComponent(externalId)}/versions/latest`;
    const body = await fetchJson(url, signal);
    const parsed = ServerSchema.safeParse(unwrap(body));
    return parsed.success ? detail(parsed.data) : null;
  }
}

function summary(server: Server): McpMarketEntry {
  return {
    source: 'official',
    externalId: server.name,
    name: server.title ?? server.name,
    description: server.description ?? '',
    ...(server.repository?.url ? { repositoryUrl: server.repository.url } : {}),
    detailUrl: server.websiteUrl ?? server.repository?.url ?? `https://registry.modelcontextprotocol.io/server/${server.name}`,
  };
}

function detail(server: Server): McpMarketEntryDetail {
  const base = summary(server);
  const remote = server.remotes?.find(item => item.type === 'streamable-http');
  if (remote) {
    const headers: Record<string, string> = {};
    const requiredInputs: McpMarketInstallInput[] = [];
    for (const header of remote.headers ?? []) {
      if (header.value !== undefined && !hasTemplate(header.value)) headers[header.name] = header.value;
      else if (header.isRequired) requiredInputs.push({
        key: header.name,
        target: 'header',
        secret: header.isSecret ?? true,
        ...(header.description ? { description: header.description } : {}),
      });
    }
    return {
      ...base,
      config: { type: 'http', url: remote.url, ...(Object.keys(headers).length ? { headers } : {}) },
      requiredInputs,
    };
  }

  for (const pkg of server.packages ?? []) {
    const config = packageConfig(pkg);
    if (config) return { ...base, ...config };
  }
  return { ...base, requiredInputs: [], unavailableReason: '该条目没有 Streamable HTTP 或 npm/pypi 启动配置.' };
}

function packageConfig(pkg: NonNullable<Server['packages']>[number]): Pick<McpMarketEntryDetail, 'config' | 'requiredInputs'> | null {
  const registry = pkg.registryType;
  const name = pkg.identifier ?? pkg.name;
  if (!name || !pkg.version) return null;
  let command: string;
  let args: string[];
  if (registry === 'npm') {
    command = 'npx';
    args = ['-y', `${name}@${pkg.version}`];
  } else if (registry === 'pypi') {
    command = 'uvx';
    args = [`${name}==${pkg.version}`];
  } else return null;

  for (const argument of [...(pkg.runtimeArguments ?? []), ...(pkg.packageArguments ?? [])]) {
    if (hasTemplate(argument.name ?? '') || hasTemplate(argument.value ?? '')) return null;
    if (argument.type === 'positional' && argument.value !== undefined) args.push(argument.value);
    else if (argument.type === 'named' && argument.name) {
      const flag = argument.name.startsWith('--') ? argument.name : `--${argument.name}`;
      args.push(argument.value === undefined ? flag : `${flag}=${argument.value}`);
    } else return null;
  }

  const env: Record<string, string> = {};
  const requiredInputs: McpMarketInstallInput[] = [];
  for (const variable of pkg.environmentVariables ?? []) {
    if (variable.default !== undefined && !hasTemplate(variable.default)) env[variable.name] = variable.default;
    else if (variable.isRequired) requiredInputs.push({
      key: variable.name,
      target: 'env',
      secret: variable.isSecret ?? true,
      ...(variable.description ? { description: variable.description } : {}),
    });
  }
  const config: McpServerConfig = { type: 'stdio', command, args, ...(Object.keys(env).length ? { env } : {}) };
  return { config, requiredInputs };
}

async function fetchJson(url: string, signal?: AbortSignal): Promise<unknown> {
  const timeout = AbortSignal.timeout(REQUEST_TIMEOUT_MS);
  const requestSignal = signal ? AbortSignal.any([signal, timeout]) : timeout;
  try {
    const response = await fetch(url, { headers: { Accept: 'application/json' }, signal: requestSignal });
    if (!response.ok) throw new Error(`Official MCP Registry 请求失败: HTTP ${response.status}`);
    return response.json() as Promise<unknown>;
  } catch (error) {
    if (timeout.aborted) throw new Error('Official MCP Registry 请求超时.');
    throw error;
  }
}

function pageOf(body: unknown): { servers: unknown[]; nextCursor?: string } {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return { servers: [] };
  const record = body as Record<string, unknown>;
  const metadata = record.metadata;
  const nextCursor = metadata && typeof metadata === 'object' && !Array.isArray(metadata)
    ? (metadata as Record<string, unknown>).nextCursor
    : undefined;
  return {
    servers: Array.isArray(record.servers) ? record.servers.map(unwrap) : [],
    ...(typeof nextCursor === 'string' && nextCursor ? { nextCursor } : {}),
  };
}

function unwrap(value: unknown): unknown {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return value;
  return (value as Record<string, unknown>).server ?? value;
}

function hasTemplate(value: string): boolean {
  return /\{[^}]*\}/.test(value);
}
