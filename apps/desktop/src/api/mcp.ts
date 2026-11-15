import type { InferRequestType } from 'hono/client';
import { rpcClient, readRpcJson, type RpcClient, type RpcJson } from './client.js';

export type McpServerListResult = RpcJson<RpcClient['api']['mcp']['servers']['$get']>;
export type McpServerSummary = McpServerListResult['items'][number];
export type McpServerDetail = RpcJson<RpcClient['api']['mcp']['servers'][':name']['$get']>;
export type McpCreateServerInput = InferRequestType<RpcClient['api']['mcp']['servers']['$post']>['json'];
export type McpUpdateServerInput = InferRequestType<RpcClient['api']['mcp']['servers'][':name']['$put']>['json'];
export type McpServerConfig = McpCreateServerInput['config'];
export type McpInstallProvenance = NonNullable<McpCreateServerInput['provenance']>;
export type McpAuthType = NonNullable<McpCreateServerInput['authType']>;
export type McpOAuthStartResult = RpcJson<RpcClient['api']['mcp']['servers'][':name']['oauth']['start']['$post']>;
export type McpImportResult = RpcJson<RpcClient['api']['mcp']['import']['$post']>;
export type McpProbeInput = InferRequestType<RpcClient['api']['mcp']['probe']['$post']>['json'];
export type McpProbeResult = RpcJson<RpcClient['api']['mcp']['probe']['$post']>;
export type McpMarketResult = RpcJson<RpcClient['api']['mcp']['market'][':source']['$get']>;
export type McpMarketEntry = McpMarketResult['items'][number];
export type McpMarketSource = McpMarketEntry['source'];
export type McpMarketDetail = RpcJson<RpcClient['api']['mcp']['market'][':source']['detail']['$get']>;
export type McpMarketInstallInput = InferRequestType<RpcClient['api']['mcp']['market'][':source']['install']['$post']>['json'];
export type McpEnvironmentResult = RpcJson<RpcClient['api']['mcp']['environment']['$get']>;

export const mcpApi = {
  list(): Promise<McpServerListResult> {
    return readRpcJson(rpcClient.api.mcp.servers.$get());
  },
  get(name: string): Promise<McpServerDetail> {
    return readRpcJson(rpcClient.api.mcp.servers[':name'].$get({ param: { name } }));
  },
  create(body: McpCreateServerInput) {
    return readRpcJson(rpcClient.api.mcp.servers.$post({ json: body }));
  },
  update(name: string, body: McpUpdateServerInput) {
    return readRpcJson(rpcClient.api.mcp.servers[':name'].$put({ param: { name }, json: body }));
  },
  import(json: unknown): Promise<McpImportResult> {
    return readRpcJson(rpcClient.api.mcp.import.$post({ json: { json } }));
  },
  enable(name: string) {
    return readRpcJson(rpcClient.api.mcp.servers[':name'].enable.$put({ param: { name } }));
  },
  disable(name: string) {
    return readRpcJson(rpcClient.api.mcp.servers[':name'].disable.$put({ param: { name } }));
  },
  connect(name: string) {
    return readRpcJson(rpcClient.api.mcp.servers[':name'].connect.$post({ param: { name } }));
  },
  disconnect(name: string) {
    return readRpcJson(rpcClient.api.mcp.servers[':name'].disconnect.$post({ param: { name } }));
  },
  remove(name: string) {
    return readRpcJson(rpcClient.api.mcp.servers[':name'].$delete({ param: { name } }));
  },
  startOAuth(name: string): Promise<McpOAuthStartResult> {
    return readRpcJson(rpcClient.api.mcp.servers[':name'].oauth.start.$post({ param: { name } }));
  },
  cancelOAuth(name: string) {
    return readRpcJson(rpcClient.api.mcp.servers[':name'].oauth.cancel.$post({ param: { name } }));
  },
  clearOAuthTokens(name: string) {
    return readRpcJson(rpcClient.api.mcp.servers[':name'].oauth.tokens.$delete({ param: { name } }));
  },
  probe(body: McpProbeInput): Promise<McpProbeResult> {
    return readRpcJson(rpcClient.api.mcp.probe.$post({ json: body }));
  },
  market(source: McpMarketSource, query: string, page: number): Promise<McpMarketResult> {
    return readRpcJson(rpcClient.api.mcp.market[':source'].$get({
      param: { source },
      query: { q: query, page: String(page) },
    }));
  },
  refreshMarket(source: McpMarketSource) {
    return readRpcJson(rpcClient.api.mcp.market[':source'].refresh.$post({ param: { source } }));
  },
  marketDetail(source: McpMarketSource, externalId: string): Promise<McpMarketDetail> {
    return readRpcJson(rpcClient.api.mcp.market[':source'].detail.$get({
      param: { source },
      query: { externalId },
    }));
  },
  installFromMarket(source: McpMarketSource, body: McpMarketInstallInput) {
    return readRpcJson(rpcClient.api.mcp.market[':source'].install.$post({ param: { source }, json: body }));
  },
  inspectEnvironment(): Promise<McpEnvironmentResult> {
    return readRpcJson(rpcClient.api.mcp.environment.$get());
  },
};
