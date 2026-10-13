// System API: 探活、隔离状态和终端探测. SSE 由 lib/events/systemSse.ts 消费.
import { rpcClient, readRpcJson, type RpcClient, type RpcJson } from './client.js';

export type HealthResult = RpcJson<RpcClient['health']['$get']>;
export type SandboxStatus = RpcJson<RpcClient['sandbox']['$get']>;
export type TerminalShellList = RpcJson<RpcClient['api']['system']['find-terminal-shells']['$get']>;
export type TerminalShellInfo = TerminalShellList['shells'][number];

export const systemApi = {
  /** GET /health — 探活（认证豁免）。 */
  health(): Promise<HealthResult> {
    return readRpcJson(rpcClient.health.$get());
  },

  /** GET /sandbox — 当前机器真正启用的隔离等级（裸 Windows 如实降级）。 */
  getSandboxStatus(): Promise<SandboxStatus> {
    return readRpcJson(rpcClient.sandbox.$get());
  },

  /** GET /api/system/find-terminal-shells — 集成终端可选 Shell 探测（按 kind 优先级排序）。 */
  findTerminalShells(): Promise<TerminalShellList> {
    return readRpcJson(rpcClient.api.system['find-terminal-shells'].$get());
  },

};
