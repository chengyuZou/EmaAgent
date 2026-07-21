// 定义角色情绪状态与舞台提示进入统一事件流时使用的协议。
import type { SessionId, TurnId } from '@ema-agent/contracts';

export interface StageCue {
  motion?: string;
  expression?: string;
  durationMs?: number;
  priority: number;
}

export interface EmotionState {
  primary: string;
  secondary?: string;
  intensity: number;
}

export type EmotionStreamEvent =
  | { type: 'stage_cue'; sessionId: SessionId; turnId: TurnId; cue: StageCue }
  | { type: 'emotion_changed'; sessionId: SessionId; turnId: TurnId; state: EmotionState };
