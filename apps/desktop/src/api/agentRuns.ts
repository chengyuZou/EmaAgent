// Agent Runs API：/api/agent-runs——只读（list/get/messages）；终态清理归 Session 生命周期。
import { rpcClient, readRpcJson, type RpcClient, type RpcJson } from './client.js';

export type AgentRunListResult = RpcJson<RpcClient['api']['agent-runs']['$get']>;
export type AgentRunSummary = AgentRunListResult['items'][number];
export type AgentRunDetail = RpcJson<RpcClient['api']['agent-runs'][':agentRunId']['$get']>;
export type AgentRunMessagesResult = RpcJson<RpcClient['api']['agent-runs'][':agentRunId']['messages']['$get']>;
export type AgentRunMessageItem = AgentRunMessagesResult['items'][number];

export const agentRunsApi = {
  /** GET /api/agent-runs?sessionId=。 */
  list(sessionId: string): Promise<AgentRunListResult> {
    return readRpcJson(rpcClient.api['agent-runs'].$get({ query: { sessionId } }));
  },

  /** GET /api/agent-runs/:agentRunId。 */
  get(agentRunId: string): Promise<AgentRunDetail> {
    return readRpcJson(rpcClient.api['agent-runs'][':agentRunId'].$get({ param: { agentRunId } }));
  },

  /** GET /api/agent-runs/:agentRunId/messages — 一次运行的内容流水回放。 */
  listMessages(agentRunId: string): Promise<AgentRunMessagesResult> {
    return readRpcJson(
      rpcClient.api['agent-runs'][':agentRunId'].messages.$get({ param: { agentRunId } }),
    );
  },
};
