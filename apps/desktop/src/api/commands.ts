// Commands API: 前端斜杠菜单的确定性操作目录, 包含 compact 和 Goal 管理入口.
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
