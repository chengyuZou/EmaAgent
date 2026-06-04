import type {
  SessionId, TurnId, TurnMode, AgentSubMode,
} from '@ema-agent/contracts';
import type { MemoryNodeType, MemoryItemKind } from '@ema-agent/storage';

// ── Plan context (what the planner receives at beforeLlm) ────────────────────

export interface PlanContext {
  sessionId:    SessionId;
  turnId:       TurnId;
  mode:         TurnMode;
  subMode?:     AgentSubMode;
  /** Plain-text excerpt of the current user message used as the recall query. */
  userInput:    string;
  /** Optional abort signal — long recall paths (narrative) honour it. */
  signal?:      AbortSignal;
}

// ── Recall results ────────────────────────────────────────────────────────────

export interface RecalledNode {
  id:           string;
  label:        string;
  nodeType:     MemoryNodeType;
  description:  string;
  importance:   number;
  /** Distance from anchor in BFS hops: 0 = anchor, 1 = one hop, 2 = two hops. */
  hopDistance:  number;
}

export interface RecalledEdge {
  from:     string;       // node id
  to:       string;
  relation: string;
  /** log(1 + mention_count) — recall-time computed, not stored. */
  weight:   number;
}

export interface GraphRecallResult {
  nodes: RecalledNode[];
  edges: RecalledEdge[];
}

export interface RecalledItem {
  id:          string;
  kind:        MemoryItemKind;
  title:       string;
  body:        string;
  importance:  number;
}

export interface EpisodicRecallResult {
  currentMode: RecalledItem[];
  otherModes:  RecalledItem[];
}

export interface NarrativeRecallResult {
  /** timeline → recalled snippet (already joined into a single string per timeline). */
  sections: Record<string, string>;
}

export interface RecallBundle {
  layer0:    GraphRecallResult     | null;
  layer1:    string                | null;     // session_notes.body
  layer2:    EpisodicRecallResult  | null;
}

// ── Settings ──────────────────────────────────────────────────────────────────

export interface MemorySettings {
  enabled: boolean;

  triggers: {
    pendingTokenThreshold: number;     // default 5000
    pendingTurnThreshold:  number;     // default 50
  };

  recall: {
    currentModeWeight: number;         // 0.5 – 0.9, default 0.7
    layer0AnchorTopK:  number;         // default 5
    layer0TotalBudget: number;         // anchors + neighbours, default 12
    layer2TopK:        number;         // default 6
    useReranker:       boolean;        // default true
    anchorDetection:   'embedding' | 'llm-ner' | 'hybrid';
    /**
     * Max distance from anchor when BFS-expanding. 1 = anchors + 1-hop neighbours.
     * 2 = also 2-hop. We never go beyond 2 — empirically noisy.
     */
    maxHopDistance:    1 | 2;
  };

  compaction: {
    bufferTokens: number;              // default 10000
  };
}

export const DEFAULT_MEMORY_SETTINGS: MemorySettings = {
  enabled: true,
  triggers: {
    pendingTokenThreshold: 5000,
    pendingTurnThreshold:  50,
  },
  recall: {
    currentModeWeight: 0.7,
    layer0AnchorTopK:  5,
    layer0TotalBudget: 12,
    layer2TopK:        6,
    useReranker:       true,
    anchorDetection:   'embedding',
    maxHopDistance:    2,
  },
  compaction: {
    bufferTokens: 10000,
  },
};

// ── Embedding service result (re-exported from embed/service.ts) ─────────────

export interface EmbeddedText {
  embedding:   Buffer;            // packed Float32Array
  providerId:  string;
  model:       string;
  dim:         number;
}

// ── alreadySurfaced tracker (session.meta_json bucket) ───────────────────────

export interface AlreadySurfaced {
  /** node ids surfaced in the recent N turns. */
  nodes:  string[];
  /** memory_item ids surfaced in the recent N turns. */
  items:  string[];
  /** updated_at (epoch ms) for TTL/decay. */
  updatedAt: number;
}
