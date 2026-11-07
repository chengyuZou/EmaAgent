export type LogLevel = 'debug' | 'info' | 'warn' | 'error';
export type LogValue = null | boolean | number | string | LogValue[] | { [key: string]: LogValue };

/** 从异常中提取的诊断信息, 不包含 SDK 的请求, 响应或配置对象. */
export interface LogError {
  name?: string;
  /** 异常本身的说明. 操作背景写在 LogRow.message. */
  message: string;
  /** 错误堆栈, 例如 Error.stack. 原始异常没有堆栈时不填. */
  stack?: string;
  /** 库或操作系统提供的错误码, 例如 ECONNREFUSED. */
  code?: string | number;
  /** HTTP 状态码. 进程退出码等业务状态写入 body. */
  status?: number;
  /** 导致当前异常的前一个错误. 循环或过深的来源链会省略并标记 truncated. */
  cause?: LogError;
}

/** Node 保存的日志行格式, 每行编码为一个 UTF-8 JSON 对象. */
export interface LogRow {
  /** 记录产生时的 UTC ISO 时间, 由产生记录的进程填写. */
  time: string;
  /** 严重程度, 不用于过滤日志. */
  level: LogLevel;
  /** 发出日志的业务模块, 例如 speech 或 mcp. 不是进程来源或网络地址. */
  target: string;
  /** 产生记录的进程 PID, 不是最终写入文件的进程 PID. */
  pid: number;
  /** 代码提供的固定事件名, 例如 speech.save_failed. 不拼入用户文本或凭据. */
  event: string;
  /** 给人看的操作说明. 事件名和错误已足够明确时可以省略. */
  message?: string;
  error?: LogError;
  /** 调用方选取的业务数据. 只收 JSON 值, 原生异常通过 error 传入. 没有数据时为 {}. */
  body: Record<string, LogValue>;
  /** 内容因大小, 深度或循环引用而被截断或省略, 此行不能作为完整原始记录. */
  truncated?: true;
}

/** 调用方提供内容, logging 自动补充 time 和 pid, 并把异常转换为 LogError. */
export interface LogInput extends Pick<LogRow, 'level' | 'target' | 'event' | 'message'> {
  /** catch 和外部库可能抛出任意值, 不要求调用方先把它伪装成 Error. */
  error?: unknown;
  body?: LogRow['body'];
}
