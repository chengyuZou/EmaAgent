export type DocumentProgressKind =
  | 'validate'
  | 'parse'
  | 'chunk'
  | 'embed'
  | 'complete'
  | 'error';

export interface DocumentProgressEvent {
  /** Which named KB this document belongs to. Injected by KbManager when relaying
   *  per-client events onto the aggregated bus. Absent on per-client events. */
  kbId?:     string;
  assetId:   string;
  kind:      DocumentProgressKind;
  /** 0–1 completion fraction. Undefined for discrete steps. */
  progress?: number;
  error?:    string;
}
