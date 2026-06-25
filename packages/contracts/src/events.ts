import type {
  SessionId,
  TurnId,
  TurnMode,
  ArtifactId,
  CharacterCardId,
} from './ids.js';
import type { ErrorCode } from './errors.js';
import type { ProtocolFamily } from './providers/types.js';
import type { TurnStats } from './turns.js';
import type { Artifact } from './artifact.js';
import type { AgentKind } from './agents.js';

// ── Shared sub-types ──────────────────────────────────────────────────────────

export type { TurnStats };

export interface ToolError {
  code: string;
  message: string;
}

/**
 * High-frequency detail stream inside the subagent_stream envelope.
 * Mirrors the main agent's event taxonomy — the frontend can render a
 * mini agent view per sub-agent identical to the main chat panel.
 *
 * Card view  → subscribes only to subagent_started/progress/completed/failed/aborted
 * Detail view → subscribes to subagent_stream filtered by subagentId
 *
 * Every member carries the full identity triple (sessionId / subagentId / taskId)
 * so that events remain self-sufficient when stored, filtered, or replayed
 * independently of the outer subagent_stream envelope. Multiple sessions can
 * produce concurrent sub-agent streams on one SSE channel and each event is
 * unambiguously addressable.
 *
 *   sessionId  — which user session this belongs to
 *   subagentId — the sub-agent's identity (also its internal turnId)
 *   taskId     — AgentTaskStore task ID; absent until sub-agents are wired into
 *                the task journal (V1.5); optional so the type is forward-compatible
 */
export type SubagentInnerEvent =
  /** New LLM iteration starting — heartbeat with timing and cumulative state. */
  | { type: 'iteration';
      sessionId: SessionId; subagentId: string; taskId?: string;
      n: number; elapsedMs: number }
  /** Streaming assistant text chunk. */
  | { type: 'text_delta';
      sessionId: SessionId; subagentId: string; taskId?: string;
      delta: string }
  /** Streaming reasoning/thinking chunk (DeepSeek-R1, extended thinking). */
  | { type: 'reasoning_delta';
      sessionId: SessionId; subagentId: string; taskId?: string;
      delta: string }
  /** Tool call dispatched — args may be large; truncate before rendering. */
  | { type: 'tool_call';
      sessionId: SessionId; subagentId: string; taskId?: string;
      callId: string; name: string; args: unknown; iteration: number }
  /** Tool call resolved — excerpt capped at ~500 chars; bytes = original size. */
  | { type: 'tool_result';
      sessionId: SessionId; subagentId: string; taskId?: string;
      callId: string; name: string; excerpt: string; bytes: number;
      isError: boolean; error?: ToolError; durationMs: number }

export interface StageCue {
  motion?: string;
  expression?: string;
  durationMs?: number;
  priority: number;
}

export interface LipSyncFrame {
  t: number;
  mouth: number;
}

export interface EmotionState {
  primary: string;
  secondary?: string;
  intensity: number;
}

/**
 * One question inside an `ask_user_required` batch. Mirrors the shape the
 * built-in `ask_user` tool accepts as input, with an added stable `id` so the
 * orchestrator can correlate answers back to the question.
 */
export interface AskUserQuestionSpec {
  /** Stable per-batch question id (e.g. `q0`, `q1`). Used as the key in `answers`. */
  id: string;
  /** The question shown to the user. */
  question: string;
  /** Very short label (≤12 chars) shown as a chip/tag in the UI. */
  header: string;
  /**
   * Multiple-choice options. Omit for freeform text answer.
   * When present, `multiSelect` decides whether the UI allows multiple picks.
   */
  options?: Array<{ label: string; description?: string }>;
  multiSelect?: boolean;
  /** When true, the UI shows an "Other (custom)" free-text fallback alongside options. */
  allowCustom?: boolean;
  /** Placeholder shown in the text input (text questions only). */
  placeholder?: string;
}

export type MemoryRecallLayer = 'layer0' | 'layer1' | 'layer2';
export type MemoryRecallLayerStatus = 'succeeded' | 'skipped' | 'failed';

export interface MemoryRecallLayerReport {
  status: MemoryRecallLayerStatus;
  itemCount: number;
  tokenEstimate: number;
  durationMs: number;
  error?: string;
  skippedReason?: string;
}

// ── EmaStreamEvent union ──────────────────────────────────────────────────────

export type EmaStreamEvent =
  // Turn lifecycle
  | { type: 'turn_started';   sessionId: SessionId; turnId: TurnId; mode: TurnMode }
  | { type: 'usage_update';   sessionId: SessionId; turnId: TurnId; inputTokens: number; outputTokens: number }
  | { type: 'turn_completed'; sessionId: SessionId; turnId: TurnId; stats: TurnStats }
  | { type: 'turn_failed';    sessionId: SessionId; turnId: TurnId; code: ErrorCode; message: string }
  | { type: 'turn_aborted';   sessionId: SessionId; turnId: TurnId; reason: string }

  // Text streaming — blockIndex tracks position within the assistant's block array
  | { type: 'output_text_delta';    sessionId: SessionId; blockIndex: number; delta: string }

  // Reasoning / thinking blocks (DeepSeek-R1, Claude extended thinking)
  | { type: 'reasoning_delta';    sessionId: SessionId; blockIndex: number; delta: string }
  | { type: 'reasoning_complete'; sessionId: SessionId; blockIndex: number }

  // Tool calls — blockIndex lets the frontend know where in the block list this tool sits
  | { type: 'tool_call_partial';  sessionId: SessionId; blockIndex: number; callId: string; name: string; argsDelta: string }
  | { type: 'tool_call_complete'; sessionId: SessionId; blockIndex: number; callId: string; name: string; args: unknown }
  | { type: 'tool_result';        sessionId: SessionId; callId: string; name: string; output?: unknown; error?: ToolError; durationMs: number }

  // Permission
  // `humanDescription` is an optional plain-language explanation of what the
  // tool will do, generated by the tool-explainer LLM (V1.5). Frontend shows
  // it above the raw command so non-technical users can decide.
  | {
      type: 'permission_required';
      sessionId: SessionId;
      promptId: string;
      tool: string;
      args: unknown;
      hint: string;
      humanDescription?: string;
    }
  | { type: 'permission_resolved'; sessionId: SessionId; promptId: string; decision: 'allow' | 'deny' }

  // Ask-user — emitted by the built-in `ask_user` tool when it runs under a
  // streaming context (Tauri / SSE). One event carries the full question
  // batch (1-4 questions); the orchestrator awaits the matching POST
  // /api/turns/:turnId/ask-user/:promptId/respond before the tool resolves.
  | {
      type: 'ask_user_required';
      sessionId: SessionId;
      turnId: TurnId;
      promptId: string;
      questions: AskUserQuestionSpec[];
      humanDescription?: string;
    }
  | {
      type: 'ask_user_resolved';
      sessionId: SessionId;
      promptId: string;
      /** Keyed by question.id; the value is the user's free-text or joined option labels. */
      answers: Record<string, string>;
    }

  // Single-purpose ask variants — simpler API surface than ask_user for common patterns.
  // All share the same POST /api/turns/:id/ask-user/:promptId/respond endpoint;
  // answer keys are standardised per type (see tool implementations for details).
  | { type: 'ask_confirm_required'; sessionId: SessionId; turnId: TurnId; promptId: string; question: string; humanDescription?: string }
  | { type: 'ask_confirm_resolved'; sessionId: SessionId; promptId: string; confirmed: boolean }
  | { type: 'ask_text_required';    sessionId: SessionId; turnId: TurnId; promptId: string; question: string; humanDescription?: string; placeholder?: string }
  | { type: 'ask_text_resolved';    sessionId: SessionId; promptId: string; text: string }
  | {
      type: 'ask_choice_required';
      sessionId: SessionId;
      turnId: TurnId;
      promptId: string;
      question: string;
      humanDescription?: string;
      options: Array<{ label: string; description?: string }>;
      multiSelect?: boolean;
      allowCustom?: boolean;
    }
  | { type: 'ask_choice_resolved'; sessionId: SessionId; promptId: string; selected: string[]; customText?: string }

  // Artifact
  | { type: 'artifact_upserted'; sessionId: SessionId; artifact: Artifact }
  | { type: 'artifact_applied';  sessionId: SessionId; id: ArtifactId }

  // Stage / Emotion — sessionId routes cues to the correct Live2D/TTS owner.
  | { type: 'stage_cue';      sessionId: SessionId; turnId: TurnId; cue: StageCue }
  | { type: 'emotion_changed'; sessionId: SessionId; turnId: TurnId; state: EmotionState }

  // TTS — audio is base64-encoded string over SSE
  | { type: 'tts_chunk';             sessionId: SessionId; turnId: TurnId; audio: string; lipsync?: LipSyncFrame[]; sentenceId: string }
  | { type: 'tts_sentence_complete'; sessionId: SessionId; turnId: TurnId; sentenceId: string }

  // Narrative
  | { type: 'narrative_route_resolved';    sessionId: SessionId; timelines: string[] }
  | { type: 'narrative_timeline_complete'; sessionId: SessionId; timeline: string; charCount: number; snippet: string }

  // Memory — turn-scoped. One event per recall layer; emitted as soon as that layer settles.
  | {
      type: 'memory_recall_evidence';
      sessionId: SessionId;
      turnId: TurnId;
      mode: TurnMode;
      layer: MemoryRecallLayer;
      report: MemoryRecallLayerReport;
    }

  // Memory compaction — turn-scoped. Emitted by MemoryPlanner.compact() via ctx.emit (beforeLlm hook).
  // Has turnId — belongs on the per-turn SSE channel, NOT the system bus.
  | { type: 'memory_compaction_started';   sessionId: SessionId; turnId: TurnId; mode: TurnMode; beforeTokens: number }
  | { type: 'memory_compaction_completed'; sessionId: SessionId; turnId: TurnId; mode: TurnMode; beforeTokens: number; afterTokens: number; savedTokens: number; durationMs: number }
  | { type: 'memory_compaction_failed';    sessionId: SessionId; turnId: TurnId; mode: TurnMode; error: string; beforeTokens: number; afterTokens: number; durationMs: number }

  // Memory pipeline telemetry — system-scoped (emitted by MemoryTaskRunner / MemoryPlanner.initialize).
  | { type: 'memory_extraction_started';    sessionId: SessionId; turnId?: TurnId; queueDepth: number }
  | { type: 'memory_extraction_completed';  sessionId: SessionId; nodes: number; edges: number; items: number; lazyQueued: number; durationMs: number }
  | { type: 'memory_extraction_failed';     sessionId: SessionId; error: string }
  | { type: 'memory_index_rebuilt';         backend: string; nodes: number; items: number; durationMs: number }
  // Reserved — not yet emitted (Round 4.5):
  | { type: 'memory_consolidation_started';   nodeCount: number }
  | { type: 'memory_consolidation_completed'; consolidated: number; durationMs: number }
  | { type: 'memory_consolidation_failed';    error: string }
  | { type: 'memory_maintenance_completed'; decayedNodes: number; decayedItems: number; dryRun: boolean; durationMs: number }
  | { type: 'memory_maintenance_failed';    error: string }
  | { type: 'memory_node_merged';           nodeId: string; label: string; fragmentCount: number }

  // Background tasks — system-scoped (memory queue worker telemetry)
  | { type: 'memory_task_started';   taskId: string; kind: string; sessionId?: SessionId }
  | { type: 'memory_task_completed'; taskId: string; kind: string; durationMs: number }
  | { type: 'memory_task_failed';    taskId: string; kind: string; error: string }

  // Knowledge-base ingest progress — system-scoped (background document indexing).
  // sessionId is optional: absent for global settings-page uploads; set later for
  // chat-dropped scope:session ingests. progress is a 0–1 fraction for the bar.
  | { type: 'kb_ingest_progress';  assetId: string; stage: 'validate' | 'parse' | 'chunk' | 'embed'; progress: number; sessionId?: SessionId }
  | { type: 'kb_ingest_completed'; assetId: string; sessionId?: SessionId }
  | { type: 'kb_ingest_failed';    assetId: string; error: string; sessionId?: SessionId }

  // Agent
  | { type: 'agent_iteration';     sessionId: SessionId; n: number }
  | { type: 'agent_breaker_tripped'; sessionId: SessionId; reason: string }

  // ── Sub-agent dashboard events ────────────────────────────────────────────────
  //
  // All emitted by SubagentSpawner (not by the tool) so model/timing/usage are
  // available. subagentId doubles as the internal turnId for the sub-agent run.
  //
  // Card-view events — low frequency, one per lifecycle transition:
  | {
      type:           'subagent_started';
      sessionId:      SessionId;
      subagentId:     string;    // = internal turnId of the sub-agent
      parentTurnId:   TurnId;
      description?:   string;
      model:          string;    // resolved model (parent model or override)
      kind:           AgentKind; // 'fork' inherits parent history; 'subagent' starts fresh
      promptExcerpt:  string;    // first 200 chars
      startedAtMs:    number;    // epoch ms — client uses for elapsed timer
    }
  | {
      type:          'subagent_progress';
      sessionId:     SessionId;
      subagentId:    string;
      iteration:     number;
      elapsedMs:     number;     // ms since subagent_started
      toolCallCount: number;     // total tool calls fired so far
    }
  | {
      type:           'subagent_completed';
      sessionId:      SessionId;
      subagentId:     string;
      outputExcerpt:  string;    // first 200 chars of final text
      iterationCount: number;
      toolCallCount:  number;
      stats:          TurnStats; // inputTokens, outputTokens, costUsd, durationMs
    }
  | {
      type:        'subagent_failed';
      sessionId:   SessionId;
      subagentId:  string;
      error:       string;
      atIteration: number;       // which iteration the error occurred in
      elapsedMs:   number;
    }
  | {
      type:       'subagent_aborted';
      sessionId:  SessionId;
      subagentId: string;
      reason:     string;
      elapsedMs:  number;
    }
  //
  // Detail-stream envelope — high frequency, subscribe only when panel is open.
  // subagentId routes the inner event to the correct detail panel.
  | { type: 'subagent_stream'; sessionId: SessionId; subagentId: string; ev: SubagentInnerEvent }

  // Provider health
  | {
      type: 'provider_health_changed';
      providerId:   string;          // provider_configs.id (UUID)
      definitionId: string;          // 'openai' / 'dashscope' 等，用于显示名
      protocol:     ProtocolFamily;  // 这个供应商用的协议
      status: 'ok' | 'failed' | 'probing' | 'unknown';
      latencyMs?: number;
      error?: string;
    }

  // Character card
  | { type: 'character_card_switched'; cardId: CharacterCardId; name: string }

  // System
  | { type: 'system_warning'; level: 'info' | 'warn' | 'error'; message: string }
