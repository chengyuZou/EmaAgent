// Turn 的持久执行审计与音频地址. 运行态请求走 Session WebSocket.
import type { UserMessagePayload } from '@ema-agent/server/routes/ws/session.js';
import {
  rpcClient,
  readRpcJson,
  readRpcVoid,
  serverClient,
  type RpcClient,
  type RpcJson,
} from './client.js';

// ── 类型（全部从路由契约推导） ────────────────────────────────────────────────

export type TurnCreateInput = UserMessagePayload & {
  readonly sessionId?: string;
  readonly projectId?: string;
};

/** 附件输入 part 的块载荷(composer 草稿与发送共用同一形状)。 */
export type TurnAttachmentBlock =
  Extract<TurnCreateInput['input'][number], { type: 'attachment' }>['block'];

export type ToolExecutionLog = RpcJson<RpcClient['api']['turns'][':turnId']['tool-executions']['$get']>;
export type TurnSpeechGenerateResult = RpcJson<RpcClient['api']['turns'][':turnId']['speech']['$post']>;
export type ToolExecutionDetail = RpcJson<RpcClient['api']['turns'][':turnId']['tool-executions'][':callId']['$get']>;
export type TurnSummaryPage = RpcJson<RpcClient['api']['turns']['$get']>;
export type TurnSummary = TurnSummaryPage['items'][number];
export type TurnDetailResult = RpcJson<RpcClient['api']['turns'][':turnId']['$get']>;

// ── API ──────────────────────────────────────────────────────────────────────

export const turnsApi = {
  /** Server 从 Turn 读取完整正文和原角色; 只生成保存, 不控制播放器. */
  generateSpeech(turnId: string): Promise<TurnSpeechGenerateResult> {
    return readRpcJson(rpcClient.api.turns[':turnId'].speech.$post({ param: { turnId } }));
  },

  cancelSpeech(turnId: string): Promise<void> {
    return readRpcVoid(rpcClient.api.turns[':turnId'].speech.cancel.$post({ param: { turnId } }));
  },

  listSummaries(sessionId: string, before?: NonNullable<TurnSummaryPage['nextCursor']>, signal?: AbortSignal) {
    return readRpcJson(rpcClient.api.turns.$get({
      query: {
        sessionId,
        beforeCreatedAt: before ? String(before.createdAt) : undefined,
        beforeId: before?.id,
        limit: '50',
      },
    }, { init: { signal } }));
  },

  get(turnId: string, signal?: AbortSignal): Promise<TurnDetailResult> {
    return readRpcJson(rpcClient.api.turns[':turnId'].$get(
      { param: { turnId } },
      { init: { signal } },
    ));
  },

  /** GET /api/turns/:turnId/tool-executions — 持久工具执行审计. */
  listToolExecutions(turnId: string, before?: NonNullable<ToolExecutionLog['nextCursor']>, signal?: AbortSignal): Promise<ToolExecutionLog> {
    return readRpcJson(rpcClient.api.turns[':turnId']['tool-executions'].$get({
      param: { turnId },
      query: {
        beforeCreatedAt: before ? String(before.createdAt) : undefined,
        beforeId: before?.id,
        limit: '50',
      },
    }, { init: { signal } }));
  },

  getToolExecution(turnId: string, callId: string, signal?: AbortSignal): Promise<ToolExecutionDetail> {
    return readRpcJson(rpcClient.api.turns[':turnId']['tool-executions'][':callId'].$get(
      { param: { turnId, callId } },
      { init: { signal } },
    ));
  },

  /** 实时与历史共用同一路由, 由浏览器读取音频, 不先下载整轮文件. */
  audioUrl(turnId: string): Promise<string> {
    return serverClient.audioUrl(`/api/turns/${encodeURIComponent(turnId)}/audio`);
  },
};
