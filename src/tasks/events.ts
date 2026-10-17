/** 任务写入或删除成功后通知消费者, 由消费者重新查询该 Session 的清单. */
export type TaskEvent = {
  readonly type: 'tasks_changed';
  readonly sessionId: string;
};
