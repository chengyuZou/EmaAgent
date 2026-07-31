// 角色资源操作错误的中文业务文案映射:主提示按错误码翻译,不让堆栈或内部路径进对话框。
import { SidecarApiError } from '../../../api/sidecar-client.js';

// CharacterResourceValidationError 的 reason → 用户可读文案。
const REASON_MESSAGES: Record<string, string> = {
  source_file_required:        '请选择要导入的源文件',
  source_directory_required:   '请选择要导入的源目录',
  destination_directory_required: '请选择导出目标目录',
  resource_type_unsupported:   '不支持的资源类型',
  resource_too_large:          '文件超过大小限制',
  resource_directory_too_large:'目录总大小超过限制(当前 1.5GB)',
  resource_file_count_exceeded:'目录内文件数量超过限制',
  resource_name_not_portable:  '文件名包含不可移植字符',
  case_fold_path_collision:    '存在大小写冲突的同名文件',
  symbolic_link_not_allowed:   '出于安全考虑不允许导入符号链接',
  source_changed_during_copy:  '复制期间源文件发生变化,请重试',
  export_destination_exists:   '导出目标里已存在同名内容,请换一个目录',
  portrait_format_unsupported: '立绘格式不支持,仅接受 PNG / JPEG / WebP',
  portrait_dimensions_invalid: '立绘尺寸超过安全限制',
  voice_format_unsupported:    '音频格式不支持或文件头损坏',
  voice_duration_invalid:      '音频时长无效或超过限制',
  live2d_entry_invalid:        '入口文件无效或不存在,请检查入口相对路径',
  live2d_reference_invalid:    'Live2D 配置中的内部引用无效',
  live2d_reference_missing:    'Live2D 配置引用的文件缺失',
  live2d_texture_invalid:      '纹理文件无效或超过限制',
};

// HTTP 层与领域 code → 文案;reason 更细时优先 reason。
const CODE_MESSAGES: Record<string, string> = {
  character_resource_path_invalid: '资源路径无效',
  builtin_readonly:         '内置角色为只读,不可修改',
  card_not_found:           '角色卡不存在',
  resource_not_found:       '资源不存在,可能已被删除',
  live2d_not_found:         '该 Live2D 资源不存在,可能已被删除',
  portrait_not_found:       '该立绘不存在,可能已被删除',
  ref_not_found:            '该参考音频不存在,可能已被删除',
  payload_too_large:        '文件超过大小限制',
  invalid_request:          '请求参数无效',
  operation_in_progress:    '该角色已有资源操作正在进行,请稍候',
  sidecar_unreachable:      '本地服务不可用,请稍后再试',
};

export interface ResourceErrorDescription {
  /** 主提示:中文业务文案,可直接进对话框或 toast。 */
  message: string;
  /** 详细信息:安全的机器码组合(无路径、无堆栈),可放次要区域。 */
  detail?: string;
}

export function describeResourceError(err: unknown, fallback: string): ResourceErrorDescription {
  if (err instanceof SidecarApiError) {
    const message = (err.reason && REASON_MESSAGES[err.reason])
      ?? (err.code && CODE_MESSAGES[err.code]);
    const detail = [err.code, err.reason].filter(Boolean).join(' · ') || undefined;
    return message
      ? { message, detail }
      : { message: fallback, detail: detail ?? err.message.slice(0, 200) };
  }
  return {
    message: fallback,
    detail: err instanceof Error ? err.message.slice(0, 200) : undefined,
  };
}
