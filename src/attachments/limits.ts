// 附件域的固定硬限制。粘贴文本无上限:落盘后只有 path 进上下文,大小不伤模型。

/** 粘贴文本超过该字符数才落成 txt 文件;低于它前端直接进输入框。 */
export const PASTE_TEXT_MIN_CHARS = 1_000;

/** 粘贴块里定格的预览字符数:够模型判断值不值得 Read,不够刷屏。 */
export const PASTE_TEXT_PREVIEW_CHARS = 500;

/** 图片入库规范化阈值:Anthropic base64 ≤5MB 换算回原字节。 */
export const IMAGE_NORMALIZE_MAX_BYTES = 3_932_160;

/** 图片入库规范化阈值:边长上限(Anthropic API 硬限 8000×8000)。 */
export const IMAGE_NORMALIZE_MAX_DIMENSION = 8_000;

/** 残留清扫年龄:贴了没发/无行残渣超过这个年龄才被清(草稿保护窗口)。 */
export const ATTACHMENT_RESIDUE_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1_000;
