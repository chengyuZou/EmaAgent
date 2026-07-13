/**
 * MemoryTask 可以运行数小时甚至更久；租约只衡量 Worker 多久没有心跳，
 * 不是任务总时长限制。这些值属于内部并发安全策略，不暴露为用户设置。
 */
export const MEMORY_TASK_HEARTBEAT_INTERVAL_MS = 30_000;
export const MEMORY_TASK_STALE_AFTER_MS = 10 * 60_000;

/** 终态任务属于内部运行记录，保留 30 天足以排查问题。 */
export const MEMORY_TASK_TERMINAL_RETENTION_MS = 30 * 24 * 60 * 60_000;

/** 清理低频、分批执行，避免周期轮询制造长写锁。 */
export const MEMORY_TASK_CLEANUP_INTERVAL_MS = 60 * 60_000;
export const MEMORY_TASK_CLEANUP_BATCH_SIZE = 500;
