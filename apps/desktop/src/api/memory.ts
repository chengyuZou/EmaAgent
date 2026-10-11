import type { InferRequestType } from 'hono/client';
import { rpcClient, readRpcJson, readRpcVoid, type RpcClient, type RpcJson } from './client.js';

export type MemoryStats = RpcJson<RpcClient['api']['memory']['stats']['$get']>;
export type MemoryJobList = RpcJson<RpcClient['api']['memory']['jobs']['$get']>;
export type MemoryJob = MemoryJobList['items'][number];
export type MemoryJobCursor = NonNullable<MemoryJobList['nextCursor']>;
export type MemoryRecentJobs = RpcJson<RpcClient['api']['memory']['jobs']['recent']['$get']>;
export type MemoryJobDetail = RpcJson<RpcClient['api']['memory']['jobs'][':id']['$get']>['item'];
export type MemoryOverview = RpcJson<RpcClient['api']['memory']['overview']['$get']>;
export type MemoryPreview = MemoryOverview['items'][number];
export type MemoryFileList = RpcJson<RpcClient['api']['memory']['files']['$get']>;
export type MemoryFileContent = RpcJson<RpcClient['api']['memory']['files']['content']['$get']>;
export type MemorySearchInput = InferRequestType<RpcClient['api']['memory']['files']['search']['$post']>['json'];
export type MemorySearchResult = RpcJson<RpcClient['api']['memory']['files']['search']['$post']>;

export const memoryApi = {
  stats(signal?: AbortSignal): Promise<MemoryStats> {
    return readRpcJson(rpcClient.api.memory.stats.$get({}, { init: { signal } }));
  },

  overview(signal?: AbortSignal): Promise<MemoryOverview> {
    return readRpcJson(rpcClient.api.memory.overview.$get({}, { init: { signal } }));
  },

  listJobs(input: {
    readonly startAt?: number;
    readonly endAt?: number;
    readonly order: 'asc' | 'desc';
    readonly page: number;
    readonly cursor?: MemoryJobCursor;
  }, signal?: AbortSignal): Promise<MemoryJobList> {
    return readRpcJson(rpcClient.api.memory.jobs.$get({
      query: {
        order: input.order,
        page: String(input.page),
        ...(input.startAt !== undefined ? { startAt: String(input.startAt) } : {}),
        ...(input.endAt !== undefined ? { endAt: String(input.endAt) } : {}),
        ...(input.cursor ? {
          cursorCreatedAt: String(input.cursor.createdAt),
          cursorId: input.cursor.id,
          cursorDirection: input.cursor.direction,
        } : {}),
      },
    }, { init: { signal } }));
  },

  recentJobs(signal?: AbortSignal): Promise<MemoryRecentJobs> {
    return readRpcJson(rpcClient.api.memory.jobs.recent.$get({}, { init: { signal } }));
  },

  jobDetail(id: string, signal?: AbortSignal): Promise<MemoryJobDetail> {
    return readRpcJson(rpcClient.api.memory.jobs[':id'].$get({ param: { id } }, { init: { signal } }))
      .then(response => response.item);
  },

  ignoreJob(id: string): Promise<void> {
    return readRpcVoid(rpcClient.api.memory.jobs[':id'].ignore.$post({ param: { id } }));
  },

  ignoreAllJobs(): Promise<void> {
    return readRpcVoid(rpcClient.api.memory.jobs['ignore-all'].$post());
  },

  listFiles(opts?: {
    path?: string;
    cursor?: string;
    maxResults?: number;
  }, signal?: AbortSignal): Promise<MemoryFileList> {
    return readRpcJson(rpcClient.api.memory.files.$get({
      query: {
        ...(opts?.path ? { path: opts.path } : {}),
        ...(opts?.cursor ? { cursor: opts.cursor } : {}),
        ...(opts?.maxResults !== undefined ? { maxResults: String(opts.maxResults) } : {}),
      },
    }, { init: { signal } }));
  },

  readFile(opts: {
    path: string;
    lineOffset?: number;
    maxLines?: number;
  }, signal?: AbortSignal): Promise<MemoryFileContent> {
    return readRpcJson(rpcClient.api.memory.files.content.$get({
      query: {
        path: opts.path,
        ...(opts.lineOffset !== undefined ? { lineOffset: String(opts.lineOffset) } : {}),
        ...(opts.maxLines !== undefined ? { maxLines: String(opts.maxLines) } : {}),
      },
    }, { init: { signal } }));
  },

  search(body: MemorySearchInput, signal?: AbortSignal): Promise<MemorySearchResult> {
    return readRpcJson(rpcClient.api.memory.files.search.$post(
      { json: body },
      { init: { signal } },
    ));
  },
};
