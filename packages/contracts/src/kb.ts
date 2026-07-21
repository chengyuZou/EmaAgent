// ── Knowledge-base public API types ──────────────────────────────────────────
// KbAssetScope + search result types are the only KB types that cross package
// boundaries. Internal pipeline types (DocumentBlock, DocumentChunk, etc.) live
// in src/knowledge/types.ts and never escape that package.

/** Per-KB document scope: which documents within a specific KB are selected for a turn.
 *  Sent by the chat picker when the user selects docs from one or more KBs. */
export interface KbAssetScope {
  kbId:     string;
  assetIds: string[];
}

export interface DocumentSourceRef {
  assetId:      string;
  fileName:     string;
  page?:        number;
  sectionPath:  string[];
  /** First ~200 chars of the matched chunk for inline citation display. */
  chunkPreview: string;
}

export interface KbSearchHit {
  chunkId:   string;
  text:      string;
  markdown?: string;
  score:     number;
  source:    DocumentSourceRef;
}

export interface KbSearchResult {
  query:  string;
  hits:   KbSearchHit[];
}
