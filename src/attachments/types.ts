// Attachments 领域语言：file/image 判别联合、源文件状态、Message 稳定引用。
import type { AttachmentId, SessionId, TurnId } from '@ema-agent/ids';

interface AttachmentBase {
  readonly id: AttachmentId;
  readonly turnId: TurnId;
  readonly sessionId: SessionId;
  /** basename(realpath)，由 Server 产生。 */
  readonly name: string;
  readonly createdAt: number;
}

/** 普通文件：只记录用户原文件路径，由 FileRead 等工具按需读取。 */
export interface FileAttachment extends AttachmentBase {
  readonly kind: 'file';
  readonly mimeType: string;
  /** 用户原文件的 canonical 绝对路径。 */
  readonly sourcePath: string;
  readonly byteSize: number;
  /** 登记时的原文件最后修改时间，Unix 毫秒。 */
  readonly sourceModifiedAt: number;
}

/** 图片：登记时把原始字节复制进 Session 受管目录，历史重放不依赖原文件存活。 */
export interface ImageAttachment extends AttachmentBase {
  readonly kind: 'image';
  readonly sourcePath: string;
  readonly sourceByteSize: number;
  readonly sourceModifiedAt: number;
  /** Ema 持有的不可变原始字节副本：sessions/<sessionId>/attachments/ 下。 */
  readonly imagePath: string;
  readonly imageByteSize: number;
  /** 原始图片 MIME（image/png、image/jpeg 等），由 Server 识别。 */
  readonly mimeType: string;
}

export type Attachment = FileAttachment | ImageAttachment;

// ── 源文件状态（读取时计算，不落库） ─────────────────────────────────────────

export type AttachmentSourceStatus =
  | 'available'
  | 'modified'
  | 'missing'
  | 'inaccessible';

export type InspectedAttachment = Attachment & {
  readonly sourceStatus: AttachmentSourceStatus;
};

// ── Message 引用 ──────────────────────────────────────────────────────────────

/** Message 只保存稳定引用；附件事实只存在 turn_attachments 一处。 */
export interface AttachmentReferenceBlock {
  readonly type: 'attachment_ref';
  readonly attachmentId: AttachmentId;
}
