/** 粘贴文本超过该字符数才落成 txt 文件; 低于它前端直接进输入框. */
export const PASTE_TEXT_MIN_CHARS = 1_000;

/** 粘贴块里定格的预览字符数 */
export const PASTE_TEXT_PREVIEW_CHARS = 100;

/** 
 * 图片入库规范化阈值, 换算回原字节
 *  ≈5MB base64 减去 33% 膨胀
 */
export const IMAGE_NORMALIZE_MAX_BYTES = 3_932_160;

/** 图片入库规范化阈值:边长上限 */
export const IMAGE_NORMALIZE_MAX_DIMENSION = 8_000;

/** 残留清扫年龄:贴了没发/无行残渣超过这个时长才被清 */
export const ATTACHMENT_RESIDUE_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1_000;
