// 附件账本变化后通知会话视图重新查询。
export type AttachmentEvent = {
  readonly type: 'attachments_changed';
  readonly sessionId: string;
};
