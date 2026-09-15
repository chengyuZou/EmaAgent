// 持久 Task 变更后通知会话任务面板重新查询。
export type TaskEvent = {
  readonly type: 'tasks_changed';
  readonly sessionId: string;
};
