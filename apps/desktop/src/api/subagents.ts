// 子代理摘要与消息分别按需读取; 消息端点按 sequence 游标分页。
import { rpcClient, readRpcJson, type RpcClient, type RpcJson } from './client.js';

export type SubagentListResult = RpcJson<RpcClient['api']['subagents']['$get']>;
export type SubagentSummary = SubagentListResult['items'][number];
export type SubagentInvocation = SubagentListResult['invocations'][number];
export type SubagentDetail = RpcJson<RpcClient['api']['subagents'][':subagentId']['$get']>;
export type SubagentMessagesResult = RpcJson<RpcClient['api']['subagents'][':subagentId']['messages']['$get']>;
export type SubagentMessageItem = SubagentMessagesResult['items'][number];

export const subagentsApi = {
  /** GET /api/subagents?sessionId=。 */
  list(sessionId: string): Promise<SubagentListResult> {
    return readRpcJson(rpcClient.api['subagents'].$get({ query: { sessionId } }));
  },

  /** GET /api/subagents/:subagentId。 */
  get(subagentId: string): Promise<SubagentDetail> {
    return readRpcJson(rpcClient.api['subagents'][':subagentId'].$get({ param: { subagentId } }));
  },

  /** GET /api/subagents/:subagentId/messages。 */
  listMessages(
    subagentId: string,
    beforeSequence?: number,
    limit = 50,
  ): Promise<SubagentMessagesResult> {
    return readRpcJson(
      rpcClient.api['subagents'][':subagentId'].messages.$get({
        param: { subagentId },
        query: {
          limit: String(limit),
          ...(beforeSequence !== undefined ? { beforeSequence: String(beforeSequence) } : {}),
        },
      }),
    );
  },
};
