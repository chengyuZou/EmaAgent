// 跟踪当前进程的 Memory 后台维护状态，并只在退化边界变化时发布应用事件。

import type {
  MemoryBackgroundEvent,
  MemoryBackgroundHealth,
  MemoryBackgroundOperation,
  MemoryStoragePressure,
} from '@ema-agent/memory';

const DEGRADE_AFTER_FAILURES = 3;

const FAILURE_MESSAGES: Readonly<Record<MemoryBackgroundOperation, string>> = {
  initialization: 'Memory 初始化失败，后台维护已禁用',
  decay: 'Memory 衰减维护连续失败',
  consolidation: 'Memory 归并维护连续失败',
  embeddingRepair: 'Memory 向量修复连续失败',
  storageBudget: 'Memory 存储预算维护连续失败',
};

export class MemoryBackgroundHealthTracker {
  private activeOperation: MemoryBackgroundOperation | undefined;
  private lastCompletedAt: number | undefined;
  private lastFailure: MemoryBackgroundHealth['lastFailure'];
  private storagePressure: MemoryStoragePressure | undefined;
  private initializationUnavailable = false;
  private readonly failureCounts = new Map<MemoryBackgroundOperation, number>();

  constructor(
    private readonly emit: (event: MemoryBackgroundEvent) => void,
  ) {}

  snapshot(): MemoryBackgroundHealth {
    const degraded = this.isDegraded();
    return {
      state: degraded
        ? 'degraded'
        : this.activeOperation
          ? 'running'
          : 'idle',
      ...(this.activeOperation
        ? { activeOperation: this.activeOperation }
        : {}),
      ...(this.lastCompletedAt === undefined
        ? {}
        : { lastCompletedAt: this.lastCompletedAt }),
      ...(this.lastFailure
        ? { lastFailure: { ...this.lastFailure } }
        : {}),
      consecutiveFailures: this.highestFailureCount(),
      ...(this.storagePressure
        ? { storagePressure: { ...this.storagePressure } }
        : {}),
    };
  }

  begin(operation: MemoryBackgroundOperation): void {
    this.activeOperation = operation;
  }

  complete(
    operation: MemoryBackgroundOperation,
    storagePressure?: MemoryStoragePressure,
  ): void {
    const wasDegraded = this.isDegraded();
    this.clearActiveOperation(operation);
    this.failureCounts.delete(operation);
    if (operation === 'initialization') {
      this.initializationUnavailable = false;
    }
    if (this.lastFailure?.operation === operation) {
      this.lastFailure = undefined;
    }
    if (storagePressure) {
      this.storagePressure = { ...storagePressure };
    }
    this.lastCompletedAt = Date.now();
    this.publishDegradedBoundary(wasDegraded);
  }

  fail(operation: MemoryBackgroundOperation): void {
    const wasDegraded = this.isDegraded();
    this.clearActiveOperation(operation);
    const failures = (this.failureCounts.get(operation) ?? 0) + 1;
    this.failureCounts.set(operation, failures);
    this.lastFailure = {
      operation,
      occurredAt: Date.now(),
      message: FAILURE_MESSAGES[operation],
    };
    this.publishDegradedBoundary(wasDegraded);
  }

  markUnavailable(operation: 'initialization'): void {
    const wasDegraded = this.isDegraded();
    this.clearActiveOperation(operation);
    this.initializationUnavailable = true;
    this.failureCounts.set(operation, DEGRADE_AFTER_FAILURES);
    this.lastFailure = {
      operation,
      occurredAt: Date.now(),
      message: FAILURE_MESSAGES[operation],
    };
    this.publishDegradedBoundary(wasDegraded);
  }

  cancel(operation: MemoryBackgroundOperation): void {
    this.clearActiveOperation(operation);
  }

  private clearActiveOperation(operation: MemoryBackgroundOperation): void {
    if (this.activeOperation === operation) {
      this.activeOperation = undefined;
    }
  }

  private highestFailureCount(): number {
    let highest = 0;
    for (const count of this.failureCounts.values()) {
      highest = Math.max(highest, count);
    }
    return highest;
  }

  private isDegraded(): boolean {
    return this.initializationUnavailable
      || this.storagePressure?.remainsOverLimit === true
      || this.highestFailureCount() >= DEGRADE_AFTER_FAILURES;
  }

  private publishDegradedBoundary(wasDegraded: boolean): void {
    if (wasDegraded === this.isDegraded()) return;
    this.emit({
      type: 'memory_background_health_changed',
      health: this.snapshot(),
    });
  }
}
