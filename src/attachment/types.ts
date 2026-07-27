// 这里放 Attachment 模块用到的基础类型：附件记录、前端输入、解析给 LLM 的结果。

import type { TurnAttachment, TurnContentPart } from '@ema-agent/turn';
// TODO: 为何不能在 attachment 里定义?
import type { SessionAttachmentFileStatus } from '@ema-agent/session';

// ── 领域类型 ───────────────────────────────────────────────────────────────────

/** 持久化的附件记录，和 turn_attachments 表一对一。 */
export interface Attachment {
  id:        string;
  turnId:    string;
  sessionId: string;
  name:      string;
  mime:      string;
  size:      number;
  mtime:     number;   // unix 毫秒，让工具能发现附件化之后文件又被改过
  localPath: string;
  createdAt: number;
}

/** 附件记录与当前磁盘文件状态的组合，供模块边界查询使用。 */
export interface InspectedAttachment extends Attachment {
  fileStatus: SessionAttachmentFileStatus;
}

/** 经过文件能力校验后交给 Orchestrator 的可信附件输入。 */
export interface AttachmentInput {
  id: string;
  name: string;
  mimeType: string;
  size: number;
  mtime: number;
  localPath: string;
}

// ── 解析器输出 ─────────────────────────────────────────────────────────────────

/**
 * 一次 LLM 调用里，把一批附件解析后的结果。
 *
 * imageParts  - 小于内联上限的 image/* 文件，转成 base64。
 *               会放进 user 消息的 content parts 里，排在文本前面。
 *
 * promptLines - 其他所有附件，格式化成一段文本追加到 user 消息末尾。
 *               没有时为空字符串。
 */
export interface ResolvedPrompt {
  imageParts:  TurnContentPart[];
  promptLines: string;
}

export type AttachmentVisionTask = 'auto' | 'caption' | 'ocr' | 'layout' | 'table';

export type AttachmentImageSource =
  | { kind: 'path'; path: string }
  | { kind: 'bytes'; bytes: Uint8Array; name?: string }
  | { kind: 'base64'; data: string; name?: string };

/** 已应用方向纠正、尺寸限制和隐私元数据移除的模型输入图片。 */
export interface NormalizedAttachmentImage {
  bytes: Uint8Array;
  mimeType: 'image/png' | 'image/jpeg' | 'image/webp';
  width: number;
  height: number;
  contentSha256: string;
  transformVersion: string;
}

export interface CachedVisionDescriptionRequest {
  source: AttachmentImageSource;
  task: AttachmentVisionTask;
  providerConfigId: string;
  modelId: string;
  /** Vision 任务 Prompt 的稳定版本；Prompt 语义变化时必须升级。 */
  promptRevision: string;
  language?: string;
  signal?: AbortSignal;
}

export interface CachedVisionDescription {
  text: string;
  image: NormalizedAttachmentImage;
  cache: 'memory' | 'disk' | 'miss';
}

export type { TurnAttachment };
