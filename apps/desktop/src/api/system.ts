// System API：根路径探活与隔离状态 + /api/system 存储统计。
// SSE 事件流不进 hc 账本——走 lib/system-sse.ts 的流消费。
import { rpcClient, readRpcJson, type RpcClient, type RpcJson } from './client.js';

export type HealthResult = RpcJson<RpcClient['health']['$get']>;
export type SandboxStatus = RpcJson<RpcClient['sandbox']['$get']>;
export type DataDirStats = RpcJson<RpcClient['api']['system']['stats']['$get']>;
export type SessionStats = RpcJson<RpcClient['api']['system']['stats']['sessions'][':id']['$get']>;

export const systemApi = {
  /** GET /health — 探活（认证豁免）。 */
  health(): Promise<HealthResult> {
    return readRpcJson(rpcClient.health.$get());
  },

  /** GET /sandbox — 当前机器真正启用的隔离等级（裸 Windows 如实降级）。 */
  getSandboxStatus(): Promise<SandboxStatus> {
    return readRpcJson(rpcClient.sandbox.$get());
  },

  /** GET /api/system/stats — 数据目录聚合统计。 */
  getStats(): Promise<DataDirStats> {
    return readRpcJson(rpcClient.api.system.stats.$get());
  },

  /** GET /api/system/stats/sessions/:id — 单 Session 统计。 */
  getSessionStats(id: string): Promise<SessionStats> {
    return readRpcJson(rpcClient.api.system.stats.sessions[':id'].$get({ param: { id } }));
  },
};
