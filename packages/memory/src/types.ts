import type {
  SessionId,
  TurnId,
  TurnMode,
  EmaStreamEvent,
} from '@ema-agent/contracts';
import type { LlmMessage } from '@ema-agent/llm';
import type { MemoryNodeType, MemoryItemKind } from '@ema-agent/storage';


interface CompactResultBase {
  messages: LlmMessage[];
  microCleared: number;
  beforeTokens: number;
  afterTokens: number;
  savedTokens: number;
}

export type CompactResult =
  | (CompactResultBase & {
      status: 'not_needed';
      macroRan: false;
      reason: 'disabled' | 'session_disabled' | 'below_threshold' | 'insufficient_history';
    })
  | (CompactResultBase & {
      status: 'skipped';
      macroRan: false;
      reason: 'no_safe_cut' | 'hook_aborted';
      detail?: string;
    })
  | (CompactResultBase & {
      status: 'failed';
      macroRan: false;
      reason: 'macro_failed';
      detail: string;
    })
  | (CompactResultBase & {
      status: 'completed';
      macroRan: true;
    });

// ── Plan context (what the planner receives at beforeLlm) ────────────────────

export interface PlanContext {
  sessionId:    SessionId;
  turnId:       TurnId;
  mode:         TurnMode;
  /** Plain-text excerpt of the current user message used as the recall query. */
  userInput:    string;
  /** Optional abort signal — long recall paths (narrative) honour it. */
  signal?:      AbortSignal;
  emit?:        (event: EmaStreamEvent) => void;
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
  /** unix ms — injected as absolute timestamp in the context message */
  updatedAt:   number;
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
  layer1:    string                | null;     // rendered markdown from session_notes
  layer2:    EpisodicRecallResult  | null;
}

// ── Settings ──────────────────────────────────────────────────────────────────

export interface MemoryModelRef {
  providerId: string;
  model:      string;
}

export interface MemorySettings {
  enabled: boolean;

  /** Optional explicit provider+model overrides. Absent → fallback to first registered. */
  models?: {
    embed?:  MemoryModelRef;
    rerank?: MemoryModelRef;
  };

  triggers: {
    pendingTokenThreshold: number;     // default 5000
    pendingTurnThreshold:  number;     // default 50
  };

  recall: {
    currentModeWeight: number;         // 0.5 – 0.9, default 0.7
    layer0AnchorTopK:  number;         // default 5
    layer0TotalBudget: number;
    layer1KeepRecentEntries:  number;         // default 5
    layer1EntryExpiryDays:  number;         // default 30
    layer2TopK:        number;         // default 6
    useReranker:       boolean;        // default true
    anchorDetection:   'embedding' | 'llm-ner' | 'hybrid';
    /**
     * Max distance from anchor when BFS-expanding. 1 = anchors + 1-hop neighbours.
     * 2 = also 2-hop. We never go beyond 2 — empirically noisy.
     */
    maxHopDistance:    1 | 2;

    /**
     * Embedding similarity thresholds for adaptive L0 TopK.
     * When the top anchor score < minScore → skip L0 entirely (query is semantically
     * distant from all stored nodes — likely social noise or a cold start).
     * When score is between minScore and confidentScore → halve anchorTopK to
     * reduce noise from borderline-relevant anchors.
     */
    layer0AnchorMinScore:       number;
    layer0AnchorConfidentScore: number;

    /**
     * Maximum token budget for a session's L1 note before it is auto-compacted.
     * When the note exceeds this after an extraction append, a cheap LLM call
     * re-summarises it in-place using the mode-specific template.
     */
    layer1MaxTokens: number;
  };

  compaction: {
    bufferTokens: number;              // default 10000
  };

  maintenance: {
    idleThresholdMs:       number;   // 空闲多久才触发（默认 3600_000 = 1h）
    maintenanceIntervalMs: number;   // 两次 maintenance 最小间隔（默认 259200_000 = 3天）
    decayAmount:           number;   // 每次衰减扣多少 importance（0–1 标度，默认 0.1）
    decayAfterDays:        number;   // N 天未引用才衰减（默认 30）
    deleteThreshold:       number;   // importance 低于这个值（默认 15）
    deleteAfterDays:       number;   // 且超过这么久未引用（默认 30）才删除
    /** Maximum points a stale memory can regain when re-referenced. */
    reReferenceBoostMax: number;
    /** How many stale days it takes to reach the middle of the boost curve. */
    reReferenceHalfLifeDays: number;
    /** Above this importance, boost starts saturating hard. */
    boostSaturationStart: number;
    /** Larger = softer saturation; smaller = sharper cap. */
    boostSaturationSlope: number;
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
    layer1KeepRecentEntries: 5,
    layer1EntryExpiryDays: 30,
    layer2TopK:        6,
    useReranker:       true,
    anchorDetection:   'embedding',
    maxHopDistance:    2,
    layer0AnchorMinScore:       0.15,
    layer0AnchorConfidentScore: 0.45,
    layer1MaxTokens:            2000,
  },
  compaction: {
    bufferTokens: 10000,
  },

  maintenance: {
    idleThresholdMs:       3600_000,   // 1h
    maintenanceIntervalMs: 259200_000, // 3 days
    decayAmount:           0.1,        // importance is 0–1; subtract 0.1 per pass
    decayAfterDays:        30,
    deleteThreshold:       15,
    deleteAfterDays:       30,
    reReferenceBoostMax:   12,
    reReferenceHalfLifeDays: 30,
    boostSaturationStart:  75,
    boostSaturationSlope:  8,
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
