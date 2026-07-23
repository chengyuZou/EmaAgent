// 定义确实属于应用宿主环境的通用警告事件。
export interface SystemWarningEvent {
  type: 'system_warning';
  level: 'info' | 'warn' | 'error';
  message: string;
}

export type SystemEvent = SystemWarningEvent;
