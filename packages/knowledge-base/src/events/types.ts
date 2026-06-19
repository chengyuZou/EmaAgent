export type DocumentProgressKind =
  | 'validate'
  | 'parse'
  | 'chunk'
  | 'embed'
  | 'complete'
  | 'error';

export interface DocumentProgressEvent {
  assetId:   string;
  kind:      DocumentProgressKind;
  /** 0–1 completion fraction. Undefined for discrete steps. */
  progress?: number;
  error?:    string;
}
