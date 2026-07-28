// 定义设置提交成功后发送给当前进程消费者的变更通知。

export interface SettingsChangedEvent {
  revision: number;
  changedKeys: readonly string[];
}

export type SettingsChangedListener = (event: SettingsChangedEvent) => void;
