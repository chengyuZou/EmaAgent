// 定义模型输出中的角色表现标签进入统一事件流时的协议。
// 情绪是跨 Turn 的持续状态；动作是一次性播放请求。一个情绪映射至多一个
// Expression/Motion，替换式播放，不做多表情叠加。
export type StageStreamEvent =
  | { type: 'emotion_changed'; sessionId: string; turnId: string; emotion: string }
  | { type: 'motion_changed'; sessionId: string; turnId: string; motion: string };
