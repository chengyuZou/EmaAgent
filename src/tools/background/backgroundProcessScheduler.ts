interface ScheduledProcess {
  readonly id: string;
  // Promise 覆盖进程运行和收尾. 它结束后, Scheduler 才把名额交给下一条命令.
  readonly run: () => Promise<void>;
}

interface QueuedProcess {
  readonly process: ScheduledProcess;
  readonly resolve: () => void;
  readonly reject: (error: unknown) => void;
}

export class BackgroundProcessScheduler {
  private readonly queue: QueuedProcess[] = [];
  private runningCount = 0;

  constructor(private readonly maxConcurrent: () => number) {}

  enqueue(process: ScheduledProcess): Promise<void> {
    return new Promise((resolve, reject) => {
      this.queue.push({ process, resolve, reject });
      this.startQueuedProcesses();
    });
  }

  /** 排队项尚未占用名额, 取消只移出队列; 日志和业务状态由 BackgroundProcess 清理. */
  cancel(id: string): void {
    const index = this.queue.findIndex(item => item.process.id === id);
    if (index < 0) return;
    const [item] = this.queue.splice(index, 1);
    item!.resolve();
  }

  private startQueuedProcesses(): void {
    while (this.runningCount < this.maxConcurrent()) {
      const item = this.queue.shift();
      if (!item) return;
      this.runningCount += 1;
      void this.runProcess(item);
    }
  }

  private async runProcess(item: QueuedProcess): Promise<void> {
    try {
      await item.process.run();
      item.resolve();
    } catch (error) {
      item.reject(error);
    } finally {
      this.runningCount -= 1;
      this.startQueuedProcesses();
    }
  }
}
