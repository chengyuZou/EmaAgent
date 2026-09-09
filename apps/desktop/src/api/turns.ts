// Turns API：只保留持久执行审计与最终合并音频；运行态命令走 api/websocket。
import type { StartTurnPayload } from '@ema-agent/server/routes/ws/agent.js';
import {
  rpcClient,
  readRpcJson,
  serverClient,
  type RpcClient,
  type RpcJson,
} from './client.js';

// ── 类型（全部从路由契约推导） ────────────────────────────────────────────────

export type TurnCreateInput = StartTurnPayload & { readonly sessionId?: string };

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

  /** 读取已完成 Turn 的最终合并音频。 */
  readAudio(turnId: string): Promise<Response> {
    return serverClient.requestRaw(`/api/turns/${turnId}/audio`);
  },
};
