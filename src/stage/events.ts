/** 携带 Session 和 Turn 身份, 供 Desktop 判断事件是否应控制当前角色. */
export type StageStreamEvent =
  | { type: 'emotion_changed'; sessionId: string; turnId: string; emotion: string }
  | { type: 'motion_changed'; sessionId: string; turnId: string; motion: string };
