export type MemoryErrorCode =
  | 'memory/lease_lost';

/**
 * 任务租约在执行中丢失（心跳 CAS 失败，任务已被其他 Worker 领取）时抛出。
 * 恢复标记的 PK 只能挡住"标记未被删除"的窗口；认领方完整收工并删除标记后，
 * 迟到方的提交必须靠这个闸门拦下，否则 note 双写、边计数虚增。
 */
export class MemoryLeaseLostError extends Error {
  readonly code: MemoryErrorCode = 'memory/lease_lost';

  constructor(message = 'memory: task lease lost, aborting before commit') {
    super(message);
    this.name = 'MemoryLeaseLostError';
  }
}
