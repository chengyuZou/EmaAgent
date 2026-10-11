// Turn 的持久执行审计与音频地址. 运行态请求走 Session WebSocket.
import type { UserMessagePayload } from '@ema-agent/server/routes/ws/session.js';
import {
  rpcClient,
  readRpcJson,
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

// ── API ──────────────────────────────────────────────────────────────────────

export const turnsApi = {
  /** GET /api/turns/:turnId/tool-executions — 持久工具执行审计。 */
  listToolExecutions(turnId: string): Promise<ToolExecutionLog> {
    return readRpcJson(rpcClient.api.turns[':turnId']['tool-executions'].$get({ param: { turnId } }));
  },

  /** 实时与历史共用同一路由, 由浏览器读取音频, 不先下载整轮文件. */
  audioUrl(turnId: string): Promise<string> {
    return serverClient.audioUrl(`/api/turns/${encodeURIComponent(turnId)}/audio`);
  },
};
