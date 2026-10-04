// 身份、Run 和 Message 独立读取, 类型直接来自 Server Route.
import { rpcClient, readRpcJson, type RpcClient, type RpcJson } from './client.js';

export type SubagentListResult = RpcJson<RpcClient['api']['subagents']['$get']>;
export type SubagentRecord = SubagentListResult['items'][number];
export type SubagentRunPage = RpcJson<RpcClient['api']['subagents'][':subagentId']['runs']['$get']>;
export type SubagentRunItem = SubagentRunPage['items'][number];
export type SubagentMessagesResult = RpcJson<RpcClient['api']['subagents'][':subagentId']['messages']['$get']>;
export type SubagentMessageItem = SubagentMessagesResult['items'][number];
export type SubagentMessageCursor = NonNullable<SubagentMessagesResult['olderCursor']>;

export const subagentsApi = {
  list(sessionId: string, cursor?: SubagentListResult['nextCursor'], signal?: AbortSignal) {
    return readRpcJson(rpcClient.api.subagents.$get({
      query: {
        sessionId,
        ...(cursor ? {
          beforeUpdatedAt: String(cursor.updatedAt),
          beforeId: cursor.id,
        } : {}),
      },
    }, { init: { signal } }));
  },

  get(subagentId: string, signal?: AbortSignal) {
    return readRpcJson(rpcClient.api.subagents[':subagentId'].$get(
      { param: { subagentId } },
      { init: { signal } },
    ));
  },

  listRuns(subagentId: string, cursor?: SubagentRunPage['nextCursor'], signal?: AbortSignal) {
    return readRpcJson(rpcClient.api.subagents[':subagentId'].runs.$get({
      param: { subagentId },
      query: {
        ...(cursor ? {
          beforeCreatedAt: String(cursor.createdAt),
          beforeId: cursor.id,
        } : {}),
      },
    }, { init: { signal } }));
  },

  getRun(subagentId: string, runId: string, signal?: AbortSignal) {
    return readRpcJson(rpcClient.api.subagents[':subagentId'].runs[':runId'].$get(
      { param: { subagentId, runId } },
      { init: { signal } },
    ));
  },

  listMessages(
    subagentId: string,
    cursor?: SubagentMessageCursor | null,
    direction: 'before' | 'after' = 'before',
    signal?: AbortSignal,
  ) {
    let query: {
      beforeCreatedAt?: string;
      beforeId?: string;
      afterCreatedAt?: string;
      afterId?: string;
    } = {};

    if (cursor && direction === 'before') {
      query = { beforeCreatedAt: String(cursor.createdAt), beforeId: cursor.id };
    }
    if (cursor && direction === 'after') {
      query = { afterCreatedAt: String(cursor.createdAt), afterId: cursor.id };
    }

    return readRpcJson(rpcClient.api.subagents[':subagentId'].messages.$get(
      { param: { subagentId }, query },
      { init: { signal } },
    ));
  },
};
