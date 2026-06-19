// ── Knowledge-base public API types ──────────────────────────────────────────
// Used by the kb_search tool return value and consumed by agent / frontend.
// Internal KB pipeline types (DocumentBlock, DocumentChunk, etc.) live in
// packages/knowledge-base/src/types.ts and never escape that package.

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
