// Turns API：/api/turns——启动 Turn、Permission/AskUser 应答、单 Tool/子 Agent 取消、执行审计。
// SSE（events）与合并音频（audio）走 serverClient 裸流逃生口，不进 hc 类型账本。
import type { InferRequestType } from 'hono/client';
import {
  rpcClient,
  readRpcJson,
  serverClient,
  type RpcClient,
  type RpcJson,
} from './client.js';

// ── 类型（全部从路由契约推导） ────────────────────────────────────────────────

/** POST /api/turns 的请求体（`input` 为保序判别联合 TurnInputPart[]）。 */
export type TurnCreateInput = InferRequestType<RpcClient['api']['turns']['$post']>['json'];
export type TurnCreatedResponse = RpcJson<RpcClient['api']['turns']['$post']>;

/** 附件输入 part 的 attachment 载荷（composer/历史投喂用）。 */
export type TurnAttachmentInput =
  Extract<TurnCreateInput['input'][number], { type: 'attachment' }>['attachment'];

/** 窗口重开/SSE 重连后的在飞 Permission/AskUser 恢复清单。 */
export type PendingInteractions = RpcJson<RpcClient['api']['turns']['interactions']['pending']['$get']>;

/** POST .../permissions/:toolCallId/respond 的 body（判别联合）。 */
export type PermissionRespondBody = InferRequestType<
  RpcClient['api']['turns'][':turnId']['permissions'][':toolCallId']['respond']['$post']
>['json'];

/** 应答/取消交互的归一化成功形状。 */
export type InteractionAck = RpcJson<
  RpcClient['api']['turns'][':turnId']['ask-user'][':toolCallId']['respond']['$post']
>;

export type ToolCancelAck = RpcJson<RpcClient['api']['turns'][':turnId']['tools'][':toolCallId']['$delete']>;
export type ToolExecutionLog = RpcJson<RpcClient['api']['turns'][':turnId']['tool-executions']['$get']>;

// ── API ──────────────────────────────────────────────────────────────────────

export const turnsApi = {
  /** POST /api/turns — 启动一个新 Turn（返回 turnId 与可能新建的 sessionId）。 */
  create(body: TurnCreateInput): Promise<TurnCreatedResponse> {
    return readRpcJson(rpcClient.api.turns.$post({ json: body }));
  },

  /** GET /api/turns/interactions/pending — 恢复队列里的在飞 Permission/AskUser。 */
  pendingAskUser(): Promise<PendingInteractions> {
    return readRpcJson(rpcClient.api.turns.interactions.pending.$get());
  },

  /** POST /api/turns/:turnId/permissions/:toolCallId/respond — 回应用户授权决策。 */
  respondPermission(
    turnId: string,
    toolCallId: string,
    body: PermissionRespondBody,
  ): Promise<InteractionAck> {
    return readRpcJson(
      rpcClient.api.turns[':turnId'].permissions[':toolCallId'].respond.$post({
        json: body,
        param: { turnId, toolCallId },
      }),
    );
  },

  /** POST /api/turns/:turnId/permissions/:toolCallId/cancel — 拒绝即取消。 */
  async cancelPermission(turnId: string, toolCallId: string): Promise<InteractionAck> {
    return readRpcJson(
      rpcClient.api.turns[':turnId'].permissions[':toolCallId'].cancel.$post({
        param: { turnId, toolCallId },
      }),
    );
  },

  /** POST /api/turns/:turnId/ask-user/:toolCallId/respond — 提交问答答案。 */
  respondAskUser(
    turnId: string,
    toolCallId: string,
    answers: Record<string, string>,
  ): Promise<InteractionAck> {
    return readRpcJson(
      rpcClient.api.turns[':turnId']['ask-user'][':toolCallId'].respond.$post({
        json: { answers },
        param: { turnId, toolCallId },
      }),
    );
  },

  /** POST /api/turns/:turnId/ask-user/:toolCallId/cancel — 取消不能伪装成空答案。 */
  cancelAskUser(turnId: string, toolCallId: string): Promise<InteractionAck> {
    return readRpcJson(
      rpcClient.api.turns[':turnId']['ask-user'][':toolCallId'].cancel.$post({
        param: { turnId, toolCallId },
      }),
    );
  },

  /** DELETE /api/turns/:turnId/tools/:toolCallId — 取消单个在飞工具。 */
  abortTool(turnId: string, toolCallId: string): Promise<ToolCancelAck> {
    return readRpcJson(
      rpcClient.api.turns[':turnId'].tools[':toolCallId'].$delete({ param: { turnId, toolCallId } }),
    );
  },

  /** DELETE /api/turns/:turnId/subagents/:agentRunId — 取消单个子 Agent。 */
  abortSubagent(turnId: string, agentRunId: string): Promise<ToolCancelAck> {
    return readRpcJson(
      rpcClient.api.turns[':turnId'].subagents[':agentRunId'].$delete({ param: { turnId, agentRunId } }),
    );
  },

  /** GET /api/turns/:turnId/tool-executions — 持久工具执行审计。 */
  listToolExecutions(turnId: string): Promise<ToolExecutionLog> {
    return readRpcJson(rpcClient.api.turns[':turnId']['tool-executions'].$get({ param: { turnId } }));
  },

  /** 打开 Turn 事件流：复用动态端口、认证与错误处理。 */
  openEvents(turnId: string, lastEventId: number, signal: AbortSignal): Promise<Response> {
    const params = new URLSearchParams();
    if (lastEventId > 0) params.set('lastEventId', String(lastEventId));
    const query = params.size > 0 ? `?${params.toString()}` : '';
    return serverClient.requestRaw(`/api/turns/${turnId}/events${query}`, {
      signal,
      headers: { Accept: 'text/event-stream' },
    });
  },

  /** 构建合并音频的流式 URL。 */
  audioUrl(turnId: string): Promise<string> {
    return serverClient.streamUrl(`/api/turns/${turnId}/audio`);
  },
};
