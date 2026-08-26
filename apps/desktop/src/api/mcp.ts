// MCP API：/api/mcp——server 注册/启停/连接/探测/更新检查、粘贴导入、
// registry 源 CRUD/聚合浏览/现场安装与 stdio 拉起批准。
import type { InferRequestType } from 'hono/client';
import { rpcClient, readRpcJson, type RpcClient, type RpcJson } from './client.js';

// ── 类型（全部从路由契约推导） ────────────────────────────────────────────────

export type McpServerListResult = RpcJson<RpcClient['api']['mcp']['servers']['$get']>;
export type McpServerItem = McpServerListResult['items'][number];
export type McpConnection = McpServerItem['connection'];
export type McpRegisterInput = InferRequestType<RpcClient['api']['mcp']['servers']['$post']>['json'];
export type McpServerConfig = McpRegisterInput['config'];
export type McpInstallProvenance = NonNullable<McpRegisterInput['provenance']>;
export type McpRegisterResult = RpcJson<RpcClient['api']['mcp']['servers']['$post']>;
export type McpImportResult = RpcJson<RpcClient['api']['mcp']['import']['$post']>;
export type McpServerDetail = RpcJson<RpcClient['api']['mcp']['servers'][':name']['$get']>;
export type McpCheckUpdateResult = RpcJson<RpcClient['api']['mcp']['servers'][':name']['check-update']['$post']>;
export type McpProbeInput = InferRequestType<RpcClient['api']['mcp']['probe']['$post']>['json'];
export type McpProbeResult = RpcJson<RpcClient['api']['mcp']['probe']['$post']>;
export type McpRegistrySourceList = RpcJson<RpcClient['api']['mcp']['registry-sources']['$get']>;
export type McpRegistrySource = McpRegistrySourceList['items'][number];
export type McpRegistrySourceAddInput = InferRequestType<RpcClient['api']['mcp']['registry-sources']['$post']>['json'];
export type McpRegistrySourcePatchInput = InferRequestType<RpcClient['api']['mcp']['registry-sources'][':id']['$patch']>['json'];
export type McpMarketEntryList = RpcJson<RpcClient['api']['mcp']['registry-entries']['$get']>;
export type McpMarketEntry = McpMarketEntryList['items'][number];
export type McpRegistryInstallInput = InferRequestType<RpcClient['api']['mcp']['registry-install']['$post']>['json'];
export type McpRegistryInstallResult = RpcJson<RpcClient['api']['mcp']['registry-install']['$post']>;

// ── API ──────────────────────────────────────────────────────────────────────

export const mcpApi = {
  list(): Promise<McpServerListResult> {
    return readRpcJson(rpcClient.api.mcp.servers.$get());
  },

  /** 注册（connect=false 只存配置）。 */
  register(body: McpRegisterInput): Promise<McpRegisterResult> {
    return readRpcJson(rpcClient.api.mcp.servers.$post({ json: body }));
  },

  /** 粘贴导入（map/单 server/裸 URL 统一走 `json` 字段）。 */
  import(jsonText: unknown): Promise<McpImportResult> {
    return readRpcJson(rpcClient.api.mcp.import.$post({ json: { json: jsonText } }));
  },

  get(name: string): Promise<McpServerDetail> {
    return readRpcJson(rpcClient.api.mcp.servers[':name'].$get({ param: { name } }));
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

  /** registry 安装的更新检查；非 registry 安装如实回答不可查。 */
  checkUpdate(name: string): Promise<McpCheckUpdateResult> {
    return readRpcJson(rpcClient.api.mcp.servers[':name']['check-update'].$post({ param: { name } }));
  },

  /** 免存探测：连不上是正常结论（ok:false），状态码恒 200。 */
  probe(body: McpProbeInput): Promise<McpProbeResult> {
    return readRpcJson(rpcClient.api.mcp.probe.$post({ json: body }));
  },

  // ── Registry 源 ─────────────────────────────────────────────────────────────

  listSources(): Promise<McpRegistrySourceList> {
    return readRpcJson(rpcClient.api.mcp['registry-sources'].$get());
  },

  addSource(body: McpRegistrySourceAddInput) {
    return readRpcJson(rpcClient.api.mcp['registry-sources'].$post({ json: body }));
  },

  patchSource(id: string, patch: McpRegistrySourcePatchInput) {
    return readRpcJson(rpcClient.api.mcp['registry-sources'][':id'].$patch({
      json: patch,
      param: { id },
    }));
  },

  removeSource(id: string) {
    return readRpcJson(rpcClient.api.mcp['registry-sources'][':id'].$delete({ param: { id } }));
  },

  /** 单源可达性探测。 */
  testSource(id: string) {
    return readRpcJson(rpcClient.api.mcp['registry-sources'][':id'].test.$post({ param: { id } }));
  },

  /** 聚合全部启用源的目录条目（即时拉取不落库）。 */
  listEntries(): Promise<McpMarketEntryList> {
    return readRpcJson(rpcClient.api.mcp['registry-entries'].$get());
  },

  /** 现场取最新版本安装。 */
  installFromRegistry(body: McpRegistryInstallInput): Promise<McpRegistryInstallResult> {
    return readRpcJson(rpcClient.api.mcp['registry-install'].$post({ json: body }));
  },

  /** stdio 拉起批准。 */
  answerApproval(requestId: string, approved: boolean) {
    return readRpcJson(rpcClient.api.mcp['stdio-approvals'][':requestId'].$post({
      json: { approved },
      param: { requestId },
    }));
  },
};
