// Background Processes API：/api/background-processes——Session 隔离的列表、增量输出与停止。
import { rpcClient, readRpcJson, type RpcClient, type RpcJson } from './client.js';
import type { InferRequestType } from 'hono/client';

type ListQuery = InferRequestType<RpcClient['api']['background-processes']['$get']>['query'];

export type BackgroundProcessListResult = RpcJson<RpcClient['api']['background-processes']['$get']>;
export type BackgroundProcessSummary = BackgroundProcessListResult['items'][number];
export type BackgroundProcessStatus = NonNullable<ListQuery['status']>;
export type BackgroundProcessOutput = RpcJson<
  RpcClient['api']['background-processes'][':backgroundProcessId']['output']['$get']
>;
export type BackgroundProcessStopResult = RpcJson<
  RpcClient['api']['background-processes'][':backgroundProcessId']['stop']['$post']
>;

export const backgroundProcessesApi = {
  /** GET /api/background-processes?sessionId=&status=&limit=。 */
  list(
    sessionId: string,
    opts?: { status?: BackgroundProcessStatus; limit?: number },
  ): Promise<BackgroundProcessListResult> {
    return readRpcJson(rpcClient.api['background-processes'].$get({
      query: {
        sessionId,
        ...(opts?.status ? { status: opts.status } : {}),
        ...(opts?.limit !== undefined ? { limit: String(opts.limit) } : {}),
      },
    }));
  },

  /** GET /api/background-processes/:backgroundProcessId/output（cursor/waitMs 长轮询）。 */
  readOutput(
    sessionId: string,
    backgroundProcessId: string,
    opts?: { cursor?: string; waitMs?: number },
  ): Promise<BackgroundProcessOutput> {
    return readRpcJson(rpcClient.api['background-processes'][':backgroundProcessId'].output.$get({
      param: { backgroundProcessId },
      query: {
        sessionId,
        ...(opts?.cursor ? { cursor: opts.cursor } : {}),
        ...(opts?.waitMs !== undefined ? { waitMs: String(opts.waitMs) } : {}),
      },
    }));
  },

  /** POST /api/background-processes/:backgroundProcessId/stop — body `{ sessionId }`。 */
  stop(
    sessionId: string,
    backgroundProcessId: string,
  ): Promise<BackgroundProcessStopResult> {
    return readRpcJson(rpcClient.api['background-processes'][':backgroundProcessId'].stop.$post({
      json: { sessionId },
      param: { backgroundProcessId },
    }));
  },
};
