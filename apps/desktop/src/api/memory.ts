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
export type MemoryWriteInput = InferRequestType<RpcClient['api']['memory']['files']['content']['$put']>['json'];
export type MemoryWriteResult = RpcJson<RpcClient['api']['memory']['files']['content']['$put']>;
export type MemoryNoteCreateInput = InferRequestType<RpcClient['api']['memory']['files']['notes']['$post']>['json'];
export type MemoryNoteCreateResult = RpcJson<RpcClient['api']['memory']['files']['notes']['$post']>;
export type MemoryBusyPathList = RpcJson<RpcClient['api']['memory']['jobs']['busy-paths']['$get']>;

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

  /** PUT /api/memory/files/content — 编辑正式记忆（mtime 冲突/整合占用时 409）。 */
  saveFileContent(body: MemoryWriteInput): Promise<MemoryWriteResult> {
    return readRpcJson(rpcClient.api.memory.files.content.$put({ json: body }));
  },

  /** POST /api/memory/files/notes — 记一条便签（下轮整合消化）。 */
  createNote(body: MemoryNoteCreateInput): Promise<MemoryNoteCreateResult> {
    return readRpcJson(rpcClient.api.memory.files.notes.$post({ json: body }));
  },

  /** GET /api/memory/jobs/busy-paths — running 整合 Job 正在改动的路径（编辑锁）。 */
  listBusyPaths(): Promise<MemoryBusyPathList> {
    return readRpcJson(rpcClient.api.memory.jobs['busy-paths'].$get());
  },
};
