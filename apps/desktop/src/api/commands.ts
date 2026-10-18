import { rpcClient, readRpcJson, type RpcClient, type RpcJson } from './client.js';

export type CommandCatalog = RpcJson<RpcClient['api']['commands']['$get']>;
export type CommandDescriptor = CommandCatalog['commands'][number];

export const commandsApi = {
  /** 确定性命令目录(名称不含 '/' 前缀). */
  list(): Promise<CommandCatalog> {
    return readRpcJson(rpcClient.api.commands.$get());
  },
};
