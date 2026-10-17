export interface SystemWarningEvent {
  type: 'system_warning';
  level: 'info' | 'warn' | 'error';
  message: string;
}
