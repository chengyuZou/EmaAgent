import type { InferRequestType } from 'hono/client';
import { rpcClient, readRpcJson, type RpcClient, type RpcJson } from './client.js';

export type MemoryStats = RpcJson<RpcClient['api']['memory']['stats']['$get']>;
export type MemoryJobList = RpcJson<RpcClient['api']['memory']['jobs']['$get']>;
export type MemoryJob = MemoryJobList['items'][number];
export type MemoryJobHistory = RpcJson<RpcClient['api']['memory']['jobs']['history']['$get']>;
export type MemoryFileList = RpcJson<RpcClient['api']['memory']['files']['$get']>;
export type MemoryFileContent = RpcJson<RpcClient['api']['memory']['files']['content']['$get']>;
export type MemorySearchInput = InferRequestType<RpcClient['api']['memory']['files']['search']['$post']>['json'];
export type MemorySearchResult = RpcJson<RpcClient['api']['memory']['files']['search']['$post']>;

export const memoryApi = {
  stats(): Promise<MemoryStats> {
    return readRpcJson(rpcClient.api.memory.stats.$get());
  },

  listJobs(): Promise<MemoryJobList> {
    return readRpcJson(rpcClient.api.memory.jobs.$get());
  },

  listJobHistory(limit = 100): Promise<MemoryJobHistory> {
    return readRpcJson(rpcClient.api.memory.jobs.history.$get({
      query: { limit: String(limit) },
    }));
  },

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

  search(body: MemorySearchInput): Promise<MemorySearchResult> {
    return readRpcJson(rpcClient.api.memory.files.search.$post({ json: body }));
  },
};
