import { rpcClient, readRpcJson, type RpcClient, type RpcJson } from './client.js';

export type DataDirStats = RpcJson<RpcClient['api']['storage-stats']['$get']>;
export type SessionStats = RpcJson<RpcClient['api']['storage-stats']['sessions'][':sessionId']['$get']>;

export const storageStatsApi = {
  getStats(signal?: AbortSignal): Promise<DataDirStats> {
    return readRpcJson(rpcClient.api['storage-stats'].$get({}, { init: { signal } }));
  },

  getSessionStats(sessionId: string, signal?: AbortSignal): Promise<SessionStats> {
    return readRpcJson(rpcClient.api['storage-stats'].sessions[':sessionId'].$get(
      { param: { sessionId } },
      { init: { signal } },
    ));
  },
};
