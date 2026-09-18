// 模型正文中的角色表现标签被识别后立即进入 Turn 事件流, 本包不保存当前舞台状态.
export type StageStreamEvent =
  | { type: 'emotion_changed'; sessionId: string; turnId: string; emotion: string }
  | { type: 'motion_changed'; sessionId: string; turnId: string; motion: string };
