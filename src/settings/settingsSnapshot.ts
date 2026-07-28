// 保存当前进程已读取的设置快照，并在成功提交后递增版本。

import type {
  SettingsChangedEvent,
  SettingsChangedListener,
} from './events.js';

export class SettingsSnapshot {
  private readonly values = new Map<string, unknown>();
  private readonly listeners = new Set<SettingsChangedListener>();
  private revision = 0;

  has(key: string): boolean {
    return this.values.has(key);
  }

  get<T>(key: string): T {
    return structuredClone(this.values.get(key) as T);
  }

  replace(key: string, value: unknown): void {
    this.values.set(key, structuredClone(value));
  }

  remove(key: string): void {
    this.values.delete(key);
  }

  publish(changedKeys: readonly string[]): void {
    this.revision += 1;
    const event: SettingsChangedEvent = {
      revision: this.revision,
      changedKeys: [...changedKeys],
    };
    for (const listener of this.listeners) listener(event);
  }

  subscribe(listener: SettingsChangedListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
}
