interface ScheduledStart {
  readonly id: string;
  readonly start: () => void;
}

export class BackgroundProcessScheduler {
  private readonly queue: ScheduledStart[] = [];
  private activeCount = 0;

  constructor(private readonly maxConcurrent: () => number) {}

  enqueue(item: ScheduledStart): void {
    this.queue.push(item);
    this.pump();
  }

  /** 排队项尚未占用运行名额, 取消不释放名额; 日志和状态由调用方清理. */
  cancel(id: string): void {
    const index = this.queue.findIndex(item => item.id === id);
    if (index < 0) return;
    this.queue.splice(index, 1);
  }

  release(): void {
    this.activeCount = Math.max(0, this.activeCount - 1);
    this.pump();
  }

  private pump(): void {
    while (this.activeCount < this.maxConcurrent()) {
      const item = this.queue.shift();
      if (!item) return;

      this.activeCount += 1;
      try {
        item.start();
      } catch (error) {
        // start() 负责记录业务失败并释放名额; 意外抛错时也不能遗留占用计数.
        this.activeCount = Math.max(0, this.activeCount - 1);
        throw error;
      }
    }
  }
}
