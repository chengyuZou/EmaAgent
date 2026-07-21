import type {
  MessageBlocks,
  SessionId,
  TurnId,
  TurnMode,
} from '@ema-agent/contracts';
import type {
  EmaStreamEvent,
} from '@ema-agent/turn';
import type { LanguageModel, LlmToolDef, Message } from '@ema-agent/llm';
import type { HookBus } from '@ema-agent/hook';

export interface ContextCompactionSettings {
  enabled: boolean;
  bufferTokens: number;
  defaultReservedOutputTokens: number;
  maximumReservedOutputTokens: number;
  keepRecentToolResults: number;
  maximumConsecutiveFailures: number;
}

export const DEFAULT_CONTEXT_COMPACTION_SETTINGS: ContextCompactionSettings = {
  enabled: true,
  bufferTokens: 13_000,
  defaultReservedOutputTokens: 8_000,
  maximumReservedOutputTokens: 20_000,
  keepRecentToolResults: 6,
  maximumConsecutiveFailures: 3,
};

export interface ContextCompactorDeps {
  llm: LanguageModel;
  hookBus?: HookBus;
  isEnabledForSession?: (sessionId: SessionId) => boolean;
  loadSessionNote?: (sessionId: SessionId) => string | null;
  persistSummary: (input: {
    sessionId: SessionId;
    turnId: TurnId;
    role: 'user';
    kind: 'summary';
    blocks: MessageBlocks;
  }) => void;
}

export interface ContextCompactionArgs {
  sessionId: SessionId;
  turnId: TurnId;
  mode: TurnMode;
  messages: Message[];
  modelContextWindow: number;
  modelMaxOutputTokens?: number;
  tools?: readonly LlmToolDef[];
  providerId: string;
  model: string;
  recentFiles?: ReadonlyArray<{ path: string; content: string; mtimeMs: number }>;
  signal?: AbortSignal;
  emit?: (event: EmaStreamEvent) => void;
}

interface ContextCompactionResultBase {
  messages: Message[];
  microCleared: number;
  beforeTokens: number;
  afterTokens: number;
  savedTokens: number;
}

export type ContextCompactionResult =
  | (ContextCompactionResultBase & {
      status: 'not_needed';
      macroRan: false;
      reason: 'disabled' | 'session_disabled' | 'below_threshold' | 'insufficient_history';
    })
  | (ContextCompactionResultBase & {
      status: 'skipped';
      macroRan: false;
      reason: 'no_safe_cut' | 'hook_aborted' | 'circuit_open';
      detail?: string;
    })
  | (ContextCompactionResultBase & {
      status: 'failed';
      macroRan: false;
      reason: 'macro_failed';
      detail: string;
    })
  | (ContextCompactionResultBase & {
      status: 'completed';
      macroRan: true;
    });
