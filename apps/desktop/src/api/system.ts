// System API：根路径只读状态（health/version/disks/sandbox）+ /api/system 统计与事件诊断。
// SSE 事件流不进 hc 账本——走 lib/system-sse.ts 的流消费。
import { rpcClient, readRpcJson, type RpcClient, type RpcJson } from './client.js';

export type HealthResult = RpcJson<RpcClient['health']['$get']>;
export type VersionResult = RpcJson<RpcClient['version']['$get']>;
export type DisksInfo = RpcJson<RpcClient['disks']['$get']>;
export type SandboxStatus = RpcJson<RpcClient['sandbox']['$get']>;
export type DataDirStats = RpcJson<RpcClient['api']['system']['stats']['$get']>;
export type SessionStats = RpcJson<RpcClient['api']['system']['stats']['sessions'][':id']['$get']>;
export type EventsDiagnostics = RpcJson<RpcClient['api']['system']['events']['diagnostics']['$get']>;

export const systemApi = {
  /** GET /health — 探活（认证豁免）。 */
  health(): Promise<HealthResult> {
    return readRpcJson(rpcClient.health.$get());
  },

  /** GET /version — 服务端包版本。 */
  version(): Promise<VersionResult> {
    return readRpcJson(rpcClient.version.$get());
  },

  /** GET /disks — 磁盘与数据目录。 */
  getDisks(): Promise<DisksInfo> {
    return readRpcJson(rpcClient.disks.$get());
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

  /** GET /api/system/events/diagnostics — SSE 订阅者数。 */
  eventsDiagnostics(): Promise<EventsDiagnostics> {
    return readRpcJson(rpcClient.api.system.events.diagnostics.$get());
  },
};
