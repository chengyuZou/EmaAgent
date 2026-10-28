export type BackgroundProcessErrorCode =
  | 'shutting_down'
  | 'stopped_before_start'
  | 'state_changed_before_stop'
  | 'not_attached'
  | 'session_deleted'
  | 'app_shutting_down'
  | 'not_found'
  | 'invalid_cursor'
  | 'cancelled_before_start';

/** 后台进程的状态与归属错误; message 用于保存终止原因和返回路由错误. */
export class BackgroundProcessError extends Error {
  constructor(
    readonly code: BackgroundProcessErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'BackgroundProcessError';
  }
}

/** 命令在真正启动前被取消; 保持 name=AbortError 供统一取消判断识别. */
export function createBackgroundProcessAbortError(): Error {
  return Object.assign(new Error('Command cancelled before start'), { name: 'AbortError' });
}
