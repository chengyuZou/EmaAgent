import type { UserMessagePayload } from '@ema-agent/server/routes/ws/session.js';
import {
  rpcClient,
  readRpcJson,
  readRpcVoid,
  serverClient,
  type RpcClient,
  type RpcJson,
} from './client.js';


export type TurnCreateInput = UserMessagePayload & {
  readonly sessionId?: string;
  readonly projectId?: string;
};

export type ToolExecutionLog = RpcJson<RpcClient['api']['turns'][':turnId']['tool-executions']['$get']>;
export type TurnSpeechGenerateResult = RpcJson<RpcClient['api']['turns'][':turnId']['speech']['$post']>;
export type TurnAudioRecords = RpcJson<RpcClient['api']['turns'][':turnId']['audio-records']['$get']>;
export type ToolExecutionDetail = RpcJson<RpcClient['api']['turns'][':turnId']['tool-executions'][':callId']['$get']>;
export type TurnSummaryPage = RpcJson<RpcClient['api']['turns']['$get']>;
export type TurnSummary = TurnSummaryPage['items'][number];
export type TurnDetailResult = RpcJson<RpcClient['api']['turns'][':turnId']['$get']>;


export const turnsApi = {
  /** 正文由 Server 读取; 未指定角色时使用当前激活角色, 只生成保存, 不控制播放器. */
  generateSpeech(turnId: string, characterName?: string): Promise<TurnSpeechGenerateResult> {
    return readRpcJson(rpcClient.api.turns[':turnId'].speech.$post({
      param: { turnId },
      json: { characterName },
    }));
  },

  getAudioRecords(turnId: string, signal?: AbortSignal): Promise<TurnAudioRecords> {
    return readRpcJson(rpcClient.api.turns[':turnId']['audio-records'].$get(
      { param: { turnId } },
      { init: { signal } },
    ));
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

  /** GET /api/turns/:turnId/tool-executions  -  持久工具执行审计. */
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
