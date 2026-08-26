// Memory API：/api/memory——后台任务、记忆文件浏览/搜索、存储状态与整合/维护入队。
// 旧图模型（nodes/items/edges/overrides/health）端点已不存在，无对应 API。
import type { InferRequestType } from 'hono/client';
import { rpcClient, readRpcJson, type RpcClient, type RpcJson } from './client.js';

export type MemoryStats = RpcJson<RpcClient['api']['memory']['stats']['$get']>;
export type MemoryJobList = RpcJson<RpcClient['api']['memory']['jobs']['$get']>;
export type MemoryJob = MemoryJobList['items'][number];
export type MemoryJobPaths = RpcJson<RpcClient['api']['memory']['jobs'][':id']['paths']['$get']>;
export type MemoryFileList = RpcJson<RpcClient['api']['memory']['files']['$get']>;
export type MemoryFileContent = RpcJson<RpcClient['api']['memory']['files']['content']['$get']>;
export type MemorySearchInput = InferRequestType<RpcClient['api']['memory']['files']['search']['$post']>['json'];
export type MemorySearchResult = RpcJson<RpcClient['api']['memory']['files']['search']['$post']>;
export type MemoryConsolidateInput = InferRequestType<RpcClient['api']['memory']['consolidate']['$post']>['json'];
export type MemoryMaintenanceInput = InferRequestType<RpcClient['api']['memory']['maintenance']['$post']>['json'];

export const memoryApi = {
  /** GET /api/memory/stats — 记忆存储状态（字节/限量/水位）。 */
  stats(): Promise<MemoryStats> {
    return readRpcJson(rpcClient.api.memory.stats.$get());
  },

  /** GET /api/memory/jobs?limit= — 最近后台任务。 */
  listJobs(limit?: number): Promise<MemoryJobList> {
    return readRpcJson(rpcClient.api.memory.jobs.$get({
      query: limit !== undefined ? { limit: String(limit) } : {},
    }));
  },

  /** GET /api/memory/jobs/:id/paths — 任务涉及的记忆路径。 */
  listJobPaths(id: string): Promise<MemoryJobPaths> {
    return readRpcJson(rpcClient.api.memory.jobs[':id'].paths.$get({ param: { id } }));
  },

  retryJob(id: string) {
    return readRpcJson(rpcClient.api.memory.jobs[':id'].retry.$post({ param: { id } }));
  },

  cancelJob(id: string) {
    return readRpcJson(rpcClient.api.memory.jobs[':id'].cancel.$post({ param: { id } }));
  },

  /** GET /api/memory/files — 记忆目录浏览（path/cursor/maxResults）。 */
  listFiles(opts?: {
    path?: string;
    cursor?: string;
    maxResults?: number;
  }): Promise<MemoryFileList> {
    return readRpcJson(rpcClient.api.memory.files.$get({
      query: {
        ...(opts?.path ? { path: opts.path } : {}),
        ...(opts?.cursor ? { cursor: opts.cursor } : {}),
        ...(opts?.maxResults !== undefined ? { maxResults: String(opts.maxResults) } : {}),
      },
    }));
  },

  /** GET /api/memory/files/content — 有界文本读取。 */
  readFile(opts: {
    path: string;
    lineOffset?: number;
    maxLines?: number;
  }): Promise<MemoryFileContent> {
    return readRpcJson(rpcClient.api.memory.files.content.$get({
      query: {
        path: opts.path,
        ...(opts.lineOffset !== undefined ? { lineOffset: String(opts.lineOffset) } : {}),
        ...(opts.maxLines !== undefined ? { maxLines: String(opts.maxLines) } : {}),
      },
    }));
  },

  /** POST /api/memory/files/search — 全文搜索。 */
  search(body: MemorySearchInput): Promise<MemorySearchResult> {
    return readRpcJson(rpcClient.api.memory.files.search.$post({ json: body }));
  },

  /** POST /api/memory/consolidate — 入队整合 Job（202）。 */
  consolidate(kind: MemoryConsolidateInput['kind']) {
    return readRpcJson(rpcClient.api.memory.consolidate.$post({ json: { kind } }));
  },

  /** POST /api/memory/maintenance — 入队维护 Job（202）。 */
  maintenance(kind: MemoryMaintenanceInput['kind']) {
    return readRpcJson(rpcClient.api.memory.maintenance.$post({ json: { kind } }));
  },
};
