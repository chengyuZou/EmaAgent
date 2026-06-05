import type { MemoryNodeType, MemoryItemKind } from '@ema-agent/storage';

// ── Extraction LLM output ────────────────────────────────────────────────────

export interface ExtractedNode {
  label:       string;
  nodeType:    MemoryNodeType;
  description: string;
  importance:  number;
}

export interface ExtractedEdge {
  fromLabel: string;
  toLabel:   string;
  relation:  string;
}

export interface ExtractedItem {
  kind:       MemoryItemKind;
  title:      string;
  body:       string;
  importance: number;
}

// packages/memory/src/extract/types.ts 里加
export interface SessionNoteEntry {
  at:     number;    // unix ms — 写入时间，不依赖 LLM 保留
  turnId: string;    // 来源 turn
  delta:  string;    // 这条 entry 的 markdown 内容
}

export interface ExtractionOutput {
  new_nodes:           ExtractedNode[];
  new_edges:           ExtractedEdge[];
  memory_items:        ExtractedItem[];
  session_note_delta:  string;
}

// ── Consolidation LLM output ─────────────────────────────────────────────────

export interface ConsolidationOutput {
  updated_description: string;
  importance_delta:    number;
}

// ── Pending fragment (lives in sessions.pending_fragments_json) ─────────────

export interface PendingFragment {
  turnId:   string;
  role:     'user' | 'assistant';
  content:  string;
  at:       number;
}
