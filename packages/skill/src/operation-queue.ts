// 这里串行化 Skill 文件读写, 避免激活读取撞上目录替换的短暂窗口.
export class SkillOperationQueue {
  private tail: Promise<void> = Promise.resolve();

  async run<T>(operation: () => Promise<T>): Promise<T> {
    const previous = this.tail.catch(() => undefined);
    let release: (() => void) | undefined;
    this.tail = new Promise<void>(resolve => {
      release = resolve;
    });
    await previous;
    try {
      return await operation();
    } finally {
      release?.();
    }
  }
}
