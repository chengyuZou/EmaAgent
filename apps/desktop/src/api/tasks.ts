// Tasks API：Task 重启恢复的只读快照；修改统一经过根 Turn 的 Task 工具。
// 规范样板：不建端点别名（别名后再 .$get() 是双倍调用 bug 的温床），
// 类型经 RpcJson/InferRequestType 从路由契约推导，不手写镜像。
import { rpcClient, readRpcJson, type RpcClient, type RpcJson } from './client.js';

export type TaskListResult = RpcJson<RpcClient['api']['tasks']['$get']>;
export type TaskDetailResult = RpcJson<RpcClient['api']['tasks'][':taskId']['$get']>;
export type TaskItem = TaskListResult['tasks'][number];

export const tasksApi = {
  /** 读取当前 Session 的持久 Task 快照。 */
  list(sessionId: string): Promise<TaskListResult> {
    return readRpcJson(rpcClient.api.tasks.$get({ query: { sessionId } }));
  },

  /** 读取单个 Task 快照；不存在时服务端 404。 */
  get(sessionId: string, taskId: string): Promise<TaskDetailResult> {
    return readRpcJson(
      rpcClient.api.tasks[':taskId'].$get({ param: { taskId }, query: { sessionId } }),
    );
  },
};
