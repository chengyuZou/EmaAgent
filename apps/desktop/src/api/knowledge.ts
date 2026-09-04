// Knowledge API：/api/kb——库注册表、文档资产、摄入/重嵌任务与混合检索。
// 业务操作全部经路径段携带目标库 id(/api/kb/:id/...);"激活"只决定 Agent 检索目标。
import type { InferRequestType } from 'hono/client';
import { rpcClient, readRpcJson, type RpcClient, type RpcJson } from './client.js';

// ── 类型（全部从路由契约推导） ────────────────────────────────────────────────

export type KnowledgeLibraryList = RpcJson<RpcClient['api']['kb']['libs']['$get']>;
export type KnowledgeLibrary = KnowledgeLibraryList['items'][number];
/** 创建响应是注册行(无计数);列表投影才有文档/任务计数。 */
export type KnowledgeLibraryCreated = RpcJson<RpcClient['api']['kb']['libs']['$post']>;
export type DocumentListResult = RpcJson<RpcClient['api']['kb'][':id']['documents']['$get']>;
export type DocumentAsset = RpcJson<RpcClient['api']['kb'][':id']['documents'][':docId']['$get']>;
export type DocumentPreview = RpcJson<RpcClient['api']['kb'][':id']['documents'][':docId']['preview']['$get']>;
export type DocumentChunksResult = RpcJson<RpcClient['api']['kb'][':id']['documents'][':docId']['chunks']['$get']>;
export type IngestTask = RpcJson<RpcClient['api']['kb'][':id']['ingest']['$post']>;
export type IngestTaskList = RpcJson<RpcClient['api']['kb'][':id']['ingest-tasks']['$get']>;
export type ReembedEnqueueResult = RpcJson<RpcClient['api']['kb'][':id']['reembed']['$post']>;
export type ReembedTaskList = RpcJson<RpcClient['api']['kb'][':id']['reembed-tasks']['$get']>;
export type StaleAssetList = RpcJson<RpcClient['api']['kb'][':id']['reembed']['stale-assets']['$get']>;
export type KnowledgeSearchResult = RpcJson<RpcClient['api']['kb'][':id']['search']['$post']>;
export type KnowledgeSearchHit = KnowledgeSearchResult['hits'][number];
export type KnowledgeIngestInput = InferRequestType<RpcClient['api']['kb'][':id']['ingest']['$post']>['json'];
export type KnowledgeReembedInput = InferRequestType<RpcClient['api']['kb'][':id']['reembed']['$post']>['json'];
export type KnowledgeSearchInput = InferRequestType<RpcClient['api']['kb'][':id']['search']['$post']>['json'];
export type KnowledgeLibraryModelsInput = InferRequestType<RpcClient['api']['kb']['libs'][':id']['models']['$patch']>['json'];

// ── API ──────────────────────────────────────────────────────────────────────

export const knowledgeApi = {
  // ── 库注册表 ────────────────────────────────────────────────────────────────

  listLibs(): Promise<KnowledgeLibraryList> {
    return readRpcJson(rpcClient.api.kb.libs.$get());
  },

  /** path 是父目录;库目录 = <path>/<随机 id> 由服务端自建。 */
  createLib(name: string, path: string) {
    return readRpcJson(rpcClient.api.kb.libs.$post({ json: { name, path } }));
  },

  renameLib(id: string, name: string) {
    return readRpcJson(rpcClient.api.kb.libs[':id'].$patch({ json: { name }, param: { id } }));
  },

  /** 激活是纯切换:决定 Agent 检索目标库;不停任何库的任务。 */
  activateLib(id: string) {
    return readRpcJson(rpcClient.api.kb.libs[':id'].activate.$post({ param: { id } }));
  },

  /** 永久删除整个库目录(创建时自建的 <父目录>/<id>)与注册记录。 */
  deleteLib(id: string) {
    return readRpcJson(rpcClient.api.kb.libs[':id'].$delete({ param: { id } }));
  },

  /** 库级 Embedding/Rerank 部分更新;embed 变更后该库既有向量标 stale。 */
  patchLibModels(id: string, input: KnowledgeLibraryModelsInput) {
    return readRpcJson(rpcClient.api.kb.libs[':id'].models.$patch({ json: input, param: { id } }));
  },

  // ── 文档资产 ────────────────────────────────────────────────────────────────

  listDocuments(kbId: string, opts?: {
    cursor?: string;
    limit?: number;
    keyword?: string;
  }): Promise<DocumentListResult> {
    return readRpcJson(rpcClient.api.kb[':id'].documents.$get({
      param: { id: kbId },
      query: {
        ...(opts?.cursor ? { cursor: opts.cursor } : {}),
        ...(opts?.limit !== undefined ? { limit: String(opts.limit) } : {}),
        ...(opts?.keyword ? { keyword: opts.keyword } : {}),
      },
    }));
  },

  getDocument(kbId: string, docId: string): Promise<DocumentAsset> {
    return readRpcJson(rpcClient.api.kb[':id'].documents[':docId'].$get({
      param: { id: kbId, docId },
    }));
  },

  getPreview(kbId: string, docId: string): Promise<DocumentPreview> {
    return readRpcJson(rpcClient.api.kb[':id'].documents[':docId'].preview.$get({
      param: { id: kbId, docId },
    }));
  },

  listChunks(
    kbId: string,
    docId: string,
    opts?: { cursor?: number; limit?: number },
  ): Promise<DocumentChunksResult> {
    return readRpcJson(rpcClient.api.kb[':id'].documents[':docId'].chunks.$get({
      param: { id: kbId, docId },
      query: {
        ...(opts?.cursor !== undefined ? { cursor: String(opts.cursor) } : {}),
        ...(opts?.limit !== undefined ? { limit: String(opts.limit) } : {}),
      },
    }));
  },

  deleteDocument(kbId: string, docId: string) {
    return readRpcJson(rpcClient.api.kb[':id'].documents[':docId'].$delete({
      param: { id: kbId, docId },
    }));
  },

  // ── 摄入 ────────────────────────────────────────────────────────────────────

  ingest(kbId: string, body: KnowledgeIngestInput): Promise<IngestTask> {
    return readRpcJson(rpcClient.api.kb[':id'].ingest.$post({ json: body, param: { id: kbId } }));
  },

  listIngestTasks(kbId: string): Promise<IngestTaskList> {
    return readRpcJson(rpcClient.api.kb[':id']['ingest-tasks'].$get({ param: { id: kbId } }));
  },

  retryIngest(kbId: string, taskId: string) {
    return readRpcJson(rpcClient.api.kb[':id']['ingest-tasks'][':taskId'].retry.$post({
      param: { id: kbId, taskId },
    }));
  },

  cancelIngest(kbId: string, taskId: string) {
    return readRpcJson(rpcClient.api.kb[':id']['ingest-tasks'][':taskId'].cancel.$post({
      param: { id: kbId, taskId },
    }));
  },

  deleteIngestTask(kbId: string, taskId: string) {
    return readRpcJson(rpcClient.api.kb[':id']['ingest-tasks'][':taskId'].$delete({
      param: { id: kbId, taskId },
    }));
  },

  // ── 重嵌 ────────────────────────────────────────────────────────────────────

  reembed(kbId: string, body: KnowledgeReembedInput): Promise<ReembedEnqueueResult> {
    return readRpcJson(rpcClient.api.kb[':id'].reembed.$post({ json: body, param: { id: kbId } }));
  },

  listStaleAssets(kbId: string): Promise<StaleAssetList> {
    return readRpcJson(rpcClient.api.kb[':id'].reembed['stale-assets'].$get({ param: { id: kbId } }));
  },

  listReembedTasks(kbId: string): Promise<ReembedTaskList> {
    return readRpcJson(rpcClient.api.kb[':id']['reembed-tasks'].$get({ param: { id: kbId } }));
  },

  retryReembed(kbId: string, taskId: string) {
    return readRpcJson(rpcClient.api.kb[':id']['reembed-tasks'][':taskId'].retry.$post({
      param: { id: kbId, taskId },
    }));
  },

  cancelReembed(kbId: string, taskId: string) {
    return readRpcJson(rpcClient.api.kb[':id']['reembed-tasks'][':taskId'].cancel.$post({
      param: { id: kbId, taskId },
    }));
  },

  deleteReembedTask(kbId: string, taskId: string) {
    return readRpcJson(rpcClient.api.kb[':id']['reembed-tasks'][':taskId'].$delete({
      param: { id: kbId, taskId },
    }));
  },

  // ── 检索 ────────────────────────────────────────────────────────────────────

  search(kbId: string, body: KnowledgeSearchInput): Promise<KnowledgeSearchResult> {
    return readRpcJson(rpcClient.api.kb[':id'].search.$post({ json: body, param: { id: kbId } }));
  },
};
