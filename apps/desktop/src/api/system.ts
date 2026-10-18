import { rpcClient, readRpcJson, type RpcClient, type RpcJson } from './client.js';

export type HealthResult = RpcJson<RpcClient['health']['$get']>;
export type SandboxStatus = RpcJson<RpcClient['sandbox']['$get']>;
export type TerminalShellList = RpcJson<RpcClient['api']['system']['find-terminal-shells']['$get']>;
export type TerminalShellInfo = TerminalShellList['shells'][number];

export const systemApi = {
  /** 健康检查无需 HTTP 认证. */
  health(): Promise<HealthResult> {
    return readRpcJson(rpcClient.health.$get());
  },

  /** Server 提供的后端与 Bash 启用策略, 不表示 PowerShell 已被隔离. */
  getSandboxStatus(): Promise<SandboxStatus> {
    return readRpcJson(rpcClient.sandbox.$get());
  },

  /** 集成终端的 Shell 候选, 按 kind 优先级排序. */
  findTerminalShells(): Promise<TerminalShellList> {
    return readRpcJson(rpcClient.api.system['find-terminal-shells'].$get());
  },

};
