// 定义角色情绪状态与舞台提示进入统一事件流时使用的协议。
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

export type StageStreamEvent =
  | { type: 'stage_cue'; sessionId: string; turnId: string; cue: StageCue }
  | { type: 'emotion_changed'; sessionId: string; turnId: string; state: EmotionState };
