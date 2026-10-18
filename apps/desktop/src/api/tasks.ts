import { rpcClient, readRpcJson, type RpcClient, type RpcJson } from './client.js';

export type TaskListResult = RpcJson<RpcClient['api']['tasks']['$get']>;
export type TaskDetailResult = RpcJson<RpcClient['api']['tasks'][':taskId']['$get']>;
export type TaskItem = TaskListResult['tasks'][number];

export const tasksApi = {
  /** 读取当前 Session 的持久 Task. */
  list(sessionId: string): Promise<TaskListResult> {
    return readRpcJson(rpcClient.api.tasks.$get({ query: { sessionId } }));
  },

  /** 读取单个 Task; 不存在时服务端 404. */
  get(sessionId: string, taskId: string): Promise<TaskDetailResult> {
    return readRpcJson(
      rpcClient.api.tasks[':taskId'].$get({ param: { taskId }, query: { sessionId } }),
    );
  },
};
