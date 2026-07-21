// 串行提交全局 Memory 数据和派生向量索引，允许事务前的模型调用跨 Session 并发。

export class MemoryCommitCoordinator {
  private tail: Promise<void> = Promise.resolve();

  runExclusive<T>(work: () => Promise<T> | T): Promise<T> {
    const result = this.tail.then(work, work);
    this.tail = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  async drain(): Promise<void> {
    await this.tail;
  }
}
