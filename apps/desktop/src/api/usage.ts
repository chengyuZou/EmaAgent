import type { InferRequestType } from 'hono/client';
import { rpcClient, readRpcJson, type RpcClient, type RpcJson } from './client.js';

type RecordsEndpoint = RpcClient['api']['usage']['records']['$get'];
type RecordsQuery = InferRequestType<RecordsEndpoint>['query'];
export type UsageRecordsPage = RpcJson<RecordsEndpoint>;

export interface UsageRecordsFilter {
  readonly sessionId?: string;
  readonly capability?: RecordsQuery['capability'];
  /** 继续读取早于这条记录的数据; 时间相同时按 ID 排序. */
  readonly before?: { readonly createdAt: number; readonly id: string };
  readonly limit?: number;
}

export const usageApi = {
  listRecords(filter: UsageRecordsFilter = {}, signal?: AbortSignal): Promise<UsageRecordsPage> {
    return readRpcJson(rpcClient.api.usage.records.$get({
      query: {
        sessionId: filter.sessionId,
        capability: filter.capability,
        beforeCreatedAt: filter.before?.createdAt.toString(),
        beforeId: filter.before?.id,
        limit: String(filter.limit ?? 100),
      },
    }, { init: { signal } }));
  },
};
