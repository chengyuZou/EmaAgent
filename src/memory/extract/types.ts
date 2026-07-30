import type { MemoryNodeType, MemoryItemKind } from '@ema-agent/storage';
import type { TurnId } from '@ema-agent/ids';

// ── Extraction LLM output ────────────────────────────────────────────────────

export interface ExtractedNode {
  label:       string;
  nodeType:    MemoryNodeType;
  description: string;
  importance:  number;
  /** 从对话原文逐字复制的证据片段；sanitize 校验其真实存在于源文本。 */
  evidenceQuote: string;
}

export interface ExtractedEdge {
  fromLabel: string;
  toLabel:   string;
  relation:  string;
  /**
   * 端点节点的 node_type, 可选。同名不同 type 的节点共存时用于精确落点;
   * 缺省时只允许 label 全库唯一兜底(B-076)。
   */
  fromType?: MemoryNodeType;
  toType?:   MemoryNodeType;
}

export interface ExtractedItem {
  kind:       MemoryItemKind;
  title:      string;
  body:       string;
  importance: number;
  /** 从对话原文逐字复制的证据片段；sanitize 校验其真实存在于源文本。 */
  evidenceQuote: string;
}

// src/memory/src/extract/types.ts 里加
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

// ── Pending fragment (lives in sessions.pending_fragments_json) ─────────────

export interface PendingFragment {
  turnId:   TurnId;
  role:     'user' | 'assistant';
  content:  string;
  at:       number;
}

export function safeParseEntries(body: string): SessionNoteEntry[] {
  try {
    const arr = JSON.parse(body);
    return Array.isArray(arr) ? arr as SessionNoteEntry[] : [];
  } catch {
    return body.trim() ? [{ at: Date.now(), turnId: 'legacy', delta: body }] : [];
  }
}
