import type { InferRequestType } from 'hono/client';
import { rpcClient, readRpcJson, type RpcClient, type RpcJson } from './client.js';

export type McpServerListResult = RpcJson<RpcClient['api']['mcp']['servers']['$get']>;
export type McpServerItem = McpServerListResult['items'][number];
export type McpConnection = McpServerItem['connection'];
export type McpRegisterInput = InferRequestType<RpcClient['api']['mcp']['servers']['$post']>['json'];
export type McpServerConfig = McpRegisterInput['config'];
export type McpInstallProvenance = NonNullable<McpRegisterInput['provenance']>;
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
  save(body: McpRegisterInput) {
    return readRpcJson(rpcClient.api.mcp.servers.$post({ json: body }));
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
