// Desktop 与 Server 之间一次 Turn 的附件提交结构。

/**
 * 权威事实只有 `sourcePath`：Server 收到后 realpath/stat 重新读取一切派生事实。
 * 其余字段是前端文件选择器已有的展示性事实，只用于预览回显，不进数据库。
 */
export interface TurnAttachmentInput {
  readonly sourcePath: string;
  readonly name?: string;
  readonly mimeType?: string;
  readonly size?: number;
  readonly mtime?: number;
}
