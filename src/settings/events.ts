export interface SettingsChangedEvent {
  /** 当前 SettingsStore 实例的通知序号, 不持久化, 新实例从 0 开始计数. */
  revision: number;
  changedKeys: readonly string[];
}

export type SettingsChangedListener = (event: SettingsChangedEvent) => void;

/** 跨窗口通知只要求重新查询设置; 不传递进程内的序号和值. */
export type SettingsEvent = { readonly type: 'settings_changed' };
