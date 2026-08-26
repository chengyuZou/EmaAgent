// 角色资源操作错误的中文业务文案映射:主提示按错误码翻译,不让堆栈或内部路径进对话框。
import { ServerApiError } from '../../../api/client.js';

// 路由 error 机器码 → 文案;无法精确翻译时回落到调用方给的场景化 fallback。
const CODE_MESSAGES: Record<string, string> = {
  not_found:            '角色或资源不存在,可能已被删除',
  read_only:            '内置角色为只读,不可修改',
  active_character:     '当前使用的角色不能删除',
  directory_conflict:   '同名角色目录已存在,请换个名称',
  invalid_request:      '请求参数无效',
  payload_too_large:    '文件超过大小限制',
  server_unreachable:   '本地服务不可用,请稍后再试',
  unauthorized:         '本地服务认证失败,请重启应用',
};

export interface ResourceErrorDescription {
  /** 主提示:中文业务文案,可直接进对话框或 toast。 */
  message: string;
  /** 详细信息:安全的机器码组合(无路径、无堆栈),可放次要区域。 */
  detail?: string;
}

export function describeResourceError(err: unknown, fallback: string): ResourceErrorDescription {
  if (err instanceof ServerApiError) {
    const message = err.code ? CODE_MESSAGES[err.code] : undefined;
    const detail = err.code;
    return message
      ? { message, detail }
      : { message: fallback, detail: detail ?? err.message.slice(0, 200) };
  }
  return {
    message: fallback,
    detail: err instanceof Error ? err.message.slice(0, 200) : undefined,
  };
}
