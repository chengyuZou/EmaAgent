export type DocumentProgressKind =
  | 'validate'
  | 'parse'
  | 'chunk'
  | 'embed'
  | 'partial_failed'
  | 'complete'
  | 'error';

export interface DocumentProgressEvent {
  /** Which named KB this document belongs to. Injected by KbManager when relaying
   *  per-client events onto the aggregated bus. Absent on per-client events. */
  kbId?:     string;
  assetId:   string;
  /** 持久队列任务身份；直接调用 KnowledgeClient 时可以省略。 */
  taskId?:   string;
  /** 当前尝试次数，用于持久层拒绝迟到事件。 */
  attempt?:  number;
  kind:      DocumentProgressKind;
  /** 0–1 completion fraction. Undefined for discrete steps. */
  progress?: number;
  error?:    string;
  totalItems?:     number;
  completedItems?: number;
  failedItems?:    number;
}
