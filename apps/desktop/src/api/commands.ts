// Commands API：/api/commands——前端斜杠菜单的确定性命令目录投影（V1 只有 compact）。
// Skill 条目不走这里，归 api/skills.js；菜单在前端合并两份目录展示。
import { rpcClient, readRpcJson, type RpcClient, type RpcJson } from './client.js';

export type CommandCatalog = RpcJson<RpcClient['api']['commands']['$get']>;
export type CommandDescriptor = CommandCatalog['commands'][number];

export const commandsApi = {
  /** 确定性命令目录（名称不含 '/' 前缀）。 */
  list(): Promise<CommandCatalog> {
    return readRpcJson(rpcClient.api.commands.$get());
  },
};
