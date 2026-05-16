import type {
  TurnId,
  TurnMode,
  AgentSubMode,
  ArtifactId,
  CharacterCardId,
} from './ids.js';
import type { LlmProtocol } from './providers/types.js';
import type { UsageSummary } from './turns.js';

// ── Shared sub-types ──────────────────────────────────────────────────────────

export type { UsageSummary };

export interface ToolError {
  code: string;
  message: string;
}

export interface Artifact {
  id: ArtifactId;
  type: string;
  title: string;
  content: string | null;
  contentLocation: 'inline' | 'file';
  contentPath?: string;
  meta: Record<string, unknown>;
  createdAt: number;
  updatedAt: number;
  appliedAt?: number;
  rejectedAt?: number;
}

export interface StageCue {
  motion?: string;
  expression?: string;
  lipsync?: LipSyncFrame[];
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

// ── EmaStreamEvent union ──────────────────────────────────────────────────────

export type EmaStreamEvent =
  // Turn lifecycle
  | { type: 'turn_started'; turnId: TurnId; mode: TurnMode; subMode?: AgentSubMode }
  | { type: 'turn_completed'; turnId: TurnId; usage: UsageSummary }
  | { type: 'turn_failed'; turnId: TurnId; code: string; message: string }
  | { type: 'turn_aborted'; turnId: TurnId; reason: string }

  // Text streaming
  | { type: 'output_text_delta'; delta: string }
  | { type: 'output_text_complete'; text: string }

  // Reasoning (agent debug sub-mode)
  | { type: 'reasoning_delta'; delta: string }
  | { type: 'reasoning_complete' }

  // Tool calls
  | { type: 'tool_call_partial'; callId: string; name: string; argsDelta: string }
  | { type: 'tool_call_complete'; callId: string; name: string; args: unknown }
  | { type: 'tool_result'; callId: string; output?: unknown; error?: ToolError }

  // Permission
  | { type: 'permission_required'; promptId: string; tool: string; args: unknown; hint: string }
  | { type: 'permission_resolved'; promptId: string; decision: 'allow' | 'deny' }

  // Artifact
  | { type: 'artifact_upserted'; artifact: Artifact }
  | { type: 'artifact_applied'; id: ArtifactId }

  // Stage / Emotion
  // turnId lets the frontend ignore cues from a preempted turn (concurrent sends).
  | { type: 'stage_cue'; turnId: TurnId; cue: StageCue }
  | { type: 'emotion_changed'; turnId: TurnId; state: EmotionState }

  // TTS — audio is base64-encoded string over SSE
  | { type: 'tts_chunk'; audio: string; lipsync?: LipSyncFrame[]; sentenceId: string }
  | { type: 'tts_sentence_complete'; sentenceId: string }

  // Memory
  | { type: 'context_compacted'; before: number; after: number; method: string }
  | { type: 'recall_evidence'; sources: string[]; itemCount: number }

  // Agent
  | { type: 'agent_iteration'; n: number }
  | { type: 'agent_breaker_tripped'; reason: string }

  // Provider health
  | {
      type: 'provider_health_changed';
      provider: LlmProtocol;
      status: 'ok' | 'failed' | 'probing' | 'unknown';
      latencyMs?: number;
      error?: string;
    }

  // Character card
  | { type: 'character_card_switched'; cardId: CharacterCardId; name: string }

  // System
  | { type: 'system_warning'; level: 'info' | 'warn' | 'error'; message: string }

  // NOTE: heartbeat is NOT pushed through TurnEventStore.
  // It is sent as a raw `event: heartbeat\ndata: {}\n\n` SSE frame directly
  // by the GET /events handler's setInterval via encodePing(). This keeps
  // keep-alive frames out of the replay buffer. The frontend must listen on
  // the `heartbeat` SSE event name (addEventListener('heartbeat', ...)), not
  // parse this as a JSON EmaStreamEvent.
  | { type: 'heartbeat'; ts: number };
