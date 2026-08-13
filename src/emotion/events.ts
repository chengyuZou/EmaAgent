// 定义角色情绪状态与舞台提示进入统一事件流时使用的协议。
import type { SessionId, TurnId } from '@ema-agent/ids';

export interface StageCue {
  motion?: string;
  expression?: string;
  priority: number;
}

export interface EmotionState {
  primary: string;
  // 预留：次要情绪（主+次情绪混合、衰减与转换矩阵），当前无写入方，后续版本接线
  secondary?: string;
  intensity: number;
}

export type EmotionStreamEvent =
  | { type: 'stage_cue'; sessionId: SessionId; turnId: TurnId; cue: StageCue }
  | { type: 'emotion_changed'; sessionId: SessionId; turnId: TurnId; state: EmotionState };
