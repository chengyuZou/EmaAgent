// Knowledge API：/api/kb——库注册表、文档资产、摄入/重嵌任务与混合检索。
import type { InferRequestType } from 'hono/client';
import { rpcClient, readRpcJson, type RpcClient, type RpcJson } from './client.js';

// ── 类型（全部从路由契约推导） ────────────────────────────────────────────────

export type KnowledgeLibraryList = RpcJson<RpcClient['api']['kb']['libs']['$get']>;
export type KnowledgeLibrary = KnowledgeLibraryList['items'][number];
export type DocumentListResult = RpcJson<RpcClient['api']['kb']['documents']['$get']>;
export type DocumentAsset = RpcJson<RpcClient['api']['kb']['documents'][':id']['$get']>;
export type DocumentPreview = RpcJson<RpcClient['api']['kb']['documents'][':id']['preview']['$get']>;
export type DocumentChunksResult = RpcJson<RpcClient['api']['kb']['documents'][':id']['chunks']['$get']>;
export type IngestTask = RpcJson<RpcClient['api']['kb']['ingest']['$post']>;
export type IngestTaskList = RpcJson<RpcClient['api']['kb']['ingest-tasks']['$get']>;
export type ReembedEnqueueResult = RpcJson<RpcClient['api']['kb']['reembed']['$post']>;
export type ReembedTaskList = RpcJson<RpcClient['api']['kb']['reembed-tasks']['$get']>;
export type StaleAssetList = RpcJson<RpcClient['api']['kb']['reembed']['stale-assets']['$get']>;
export type KnowledgeSearchResult = RpcJson<RpcClient['api']['kb']['search']['$post']>;
export type KnowledgeSearchHit = KnowledgeSearchResult['hits'][number];
export type KnowledgeIngestInput = InferRequestType<RpcClient['api']['kb']['ingest']['$post']>['json'];
export type KnowledgeReembedInput = InferRequestType<RpcClient['api']['kb']['reembed']['$post']>['json'];
export type KnowledgeSearchInput = InferRequestType<RpcClient['api']['kb']['search']['$post']>['json'];

// ── API ──────────────────────────────────────────────────────────────────────

/** 可选 kbId 统一在此展开：缺省即服务端当前活跃库。 */
const withKbId = (kbId: string | undefined) => (kbId ? { kbId } : {});

export const knowledgeApi = {
  // ── 库注册表 ────────────────────────────────────────────────────────────────

  listLibs(): Promise<KnowledgeLibraryList> {
    return readRpcJson(rpcClient.api.kb.libs.$get());
  },

  createLib(name: string, path: string) {
    return readRpcJson(rpcClient.api.kb.libs.$post({ json: { name, path } }));
  },

  renameLib(id: string, name: string) {
    return readRpcJson(rpcClient.api.kb.libs[':id'].$patch({ json: { name }, param: { id } }));
  },

  activateLib(id: string) {
    return readRpcJson(rpcClient.api.kb.libs[':id'].activate.$post({ param: { id } }));
  },

  deleteLib(id: string) {
    return readRpcJson(rpcClient.api.kb.libs[':id'].$delete({ param: { id } }));
  },

  // ── 文档资产 ────────────────────────────────────────────────────────────────

  listDocuments(opts?: {
    cursor?: string;
    limit?: number;
    keyword?: string;
    kbId?: string;
  }): Promise<DocumentListResult> {
    return readRpcJson(rpcClient.api.kb.documents.$get({
      query: {
        ...(opts?.cursor ? { cursor: opts.cursor } : {}),
        ...(opts?.limit !== undefined ? { limit: String(opts.limit) } : {}),
        ...(opts?.keyword ? { keyword: opts.keyword } : {}),
        ...withKbId(opts?.kbId),
      },
    }));
  },

  getDocument(id: string, kbId?: string): Promise<DocumentAsset> {
    return readRpcJson(rpcClient.api.kb.documents[':id'].$get({
      param: { id },
      query: withKbId(kbId),
    }));
  },

  getPreview(id: string, kbId?: string): Promise<DocumentPreview> {
    return readRpcJson(rpcClient.api.kb.documents[':id'].preview.$get({
      param: { id },
      query: withKbId(kbId),
    }));
  },

  listChunks(
    id: string,
    opts?: { cursor?: number; limit?: number; kbId?: string },
  ): Promise<DocumentChunksResult> {
    return readRpcJson(rpcClient.api.kb.documents[':id'].chunks.$get({
      param: { id },
      query: {
        ...(opts?.cursor !== undefined ? { cursor: String(opts.cursor) } : {}),
        ...(opts?.limit !== undefined ? { limit: String(opts.limit) } : {}),
        ...withKbId(opts?.kbId),
      },
    }));
  },

  deleteDocument(id: string, kbId?: string) {
    return readRpcJson(rpcClient.api.kb.documents[':id'].$delete({
      param: { id },
      query: withKbId(kbId),
    }));
  },

  // ── 摄入 ────────────────────────────────────────────────────────────────────

  ingest(body: KnowledgeIngestInput): Promise<IngestTask> {
    return readRpcJson(rpcClient.api.kb.ingest.$post({ json: body }));
  },

  listIngestTasks(kbId?: string): Promise<IngestTaskList> {
    return readRpcJson(rpcClient.api.kb['ingest-tasks'].$get({ query: withKbId(kbId) }));
  },

  retryIngest(taskId: string, kbId?: string) {
    return readRpcJson(rpcClient.api.kb['ingest-tasks'][':taskId'].retry.$post({
      param: { taskId },
      query: withKbId(kbId),
    }));
  },

  cancelIngest(taskId: string, kbId?: string) {
    return readRpcJson(rpcClient.api.kb['ingest-tasks'][':taskId'].cancel.$post({
      param: { taskId },
      query: withKbId(kbId),
    }));
  },

  // ── 重嵌 ────────────────────────────────────────────────────────────────────

  reembed(body: KnowledgeReembedInput): Promise<ReembedEnqueueResult> {
    return readRpcJson(rpcClient.api.kb.reembed.$post({ json: body }));
  },

  listStaleAssets(kbId?: string): Promise<StaleAssetList> {
    return readRpcJson(rpcClient.api.kb.reembed['stale-assets'].$get({ query: withKbId(kbId) }));
  },

  listReembedTasks(kbId?: string): Promise<ReembedTaskList> {
    return readRpcJson(rpcClient.api.kb['reembed-tasks'].$get({ query: withKbId(kbId) }));
  },

  retryReembed(taskId: string, kbId?: string) {
    return readRpcJson(rpcClient.api.kb['reembed-tasks'][':taskId'].retry.$post({
      param: { taskId },
      query: withKbId(kbId),
    }));
  },

  cancelReembed(taskId: string, kbId?: string) {
    return readRpcJson(rpcClient.api.kb['reembed-tasks'][':taskId'].cancel.$post({
      param: { taskId },
      query: withKbId(kbId),
    }));
  },

  // ── 检索 ────────────────────────────────────────────────────────────────────

  search(body: KnowledgeSearchInput): Promise<KnowledgeSearchResult> {
    return readRpcJson(rpcClient.api.kb.search.$post({ json: body }));
  },
};
