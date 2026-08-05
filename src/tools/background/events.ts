// 描述后台 Shell 状态变化，供 LocalHost 投影到 Session 事件通道。

import type {
  BackgroundProcessId,
  SessionId,
  ToolCallId,
  TurnId,
} from '@ema-agent/ids';
import type { BackgroundProcessStatus } from './types.js';

export interface BackgroundProcessEvent {
  readonly type: 'background_process_changed';
  readonly sessionId: SessionId;
  readonly backgroundProcessId: BackgroundProcessId;
  readonly originTurnId?: TurnId;
  readonly toolCallId?: ToolCallId;
  readonly status: BackgroundProcessStatus;
  /** 状态最后变更时间(终态取 completedAt,否则 startedAt/createdAt)。 */
  readonly changedAt: number;
  readonly exitCode?: number;
  readonly terminationReason?: string;
}
