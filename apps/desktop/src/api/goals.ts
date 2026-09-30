// Goal 管理与 Data 历史查询共用 Route 契约, 不镜像目标状态或自动重试旧版本操作.
import type { InferRequestType } from 'hono/client';
import { rpcClient, readRpcJson, readRpcVoid, type RpcClient, type RpcJson } from './client.js';

export type GoalListResult = RpcJson<RpcClient['api']['goals']['$get']>;
export type GoalSummary = GoalListResult['items'][number];
export type GoalDetailResult = RpcJson<RpcClient['api']['goals'][':goalId']['$get']>;
export type Goal = GoalDetailResult['goal'];
export type GoalCurrentResult = RpcJson<RpcClient['api']['goals']['current']['$get']>;
export type GoalCreateInput = InferRequestType<RpcClient['api']['goals']['$post']>['json'];
export type GoalEditInput = InferRequestType<RpcClient['api']['goals'][':goalId']['$put']>['json'];
export type GoalIdentityInput = InferRequestType<RpcClient['api']['goals'][':goalId']['$delete']>['json'];

export const goalsApi = {
  list(sessionId: string): Promise<GoalListResult> {
    return readRpcJson(rpcClient.api.goals.$get({ query: { sessionId } }));
  },

  current(sessionId: string, signal?: AbortSignal): Promise<GoalCurrentResult> {
    return readRpcJson(rpcClient.api.goals.current.$get(
      { query: { sessionId } },
      { init: { signal } },
    ));
  },

  get(sessionId: string, goalId: string): Promise<GoalDetailResult> {
    return readRpcJson(rpcClient.api.goals[':goalId'].$get({ param: { goalId }, query: { sessionId } }));
  },

  create(input: GoalCreateInput): Promise<GoalDetailResult> {
    return readRpcJson(rpcClient.api.goals.$post({ json: input }));
  },

  edit(goalId: string, input: GoalEditInput): Promise<GoalDetailResult> {
    return readRpcJson(rpcClient.api.goals[':goalId'].$put({ param: { goalId }, json: input }));
  },

  pause(goalId: string, input: GoalIdentityInput): Promise<GoalDetailResult> {
    return readRpcJson(rpcClient.api.goals[':goalId'].pause.$post({ param: { goalId }, json: input }));
  },

  activate(goalId: string, input: GoalIdentityInput): Promise<GoalDetailResult> {
    return readRpcJson(rpcClient.api.goals[':goalId'].activate.$post({ param: { goalId }, json: input }));
  },

  cancel(goalId: string, input: GoalIdentityInput): Promise<GoalDetailResult> {
    return readRpcJson(rpcClient.api.goals[':goalId'].cancel.$post({ param: { goalId }, json: input }));
  },

  remove(goalId: string, input: GoalIdentityInput): Promise<void> {
    return readRpcVoid(rpcClient.api.goals[':goalId'].$delete({ param: { goalId }, json: input }));
  },
};
