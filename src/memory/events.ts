// Memory 只通知 SQL 无法表达的入队失败；Job 状态始终以 SQL 为准。

import type { MemoryExtractionJobKind } from '@ema-agent/storage';

/**
 * Memory 包全部事件。当前只有入队失败:
 * 两条提取 Job 各自独立入队，
 * 失败的那条没有 Job 行,前端以 SQL 为事实源看不到——必须靠事件暴露。
 */
export type MemoryEvent =
  | {
      readonly type: 'memory_enqueue_failed';
      readonly turnId: string;
      readonly kind: MemoryExtractionJobKind;
      readonly error: string;
      readonly at: number;
    };

/** 应用层注入的通知出口；通知失败不能改变入队结果。 */
export type MemoryEventEmitter = (event: MemoryEvent) => void;
