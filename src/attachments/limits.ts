/** 达到此 UTF-16 长度的粘贴保存为 txt, 更短的内容留在输入框. */
export const PASTE_TEXT_MIN_CHARS = 1_000;

/** 保存到消息引用中的预览 UTF-16 长度. */
export const PASTE_TEXT_PREVIEW_CHARS = 100;

/** 触发图片转换的原始字节阈值, 相当于 5 MiB Base64 文本按 4/3 比例折算. */
export const IMAGE_NORMALIZE_MAX_BYTES = 3_932_160;

/** 触发图片缩放的边长阈值, 单位为像素. */
export const IMAGE_NORMALIZE_MAX_DIMENSION = 8_000;

/** 未发送附件和没有账本行的文件达到此年龄后才参与清理, 单位为毫秒. */
export const ATTACHMENT_RESIDUE_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1_000;
