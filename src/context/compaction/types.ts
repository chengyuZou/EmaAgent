import type { SessionId, TurnId } from '@ema-agent/ids';
import type { MessageBlocks } from '@ema-agent/session';
import type { ExecutionProfile, NarrativePolicy } from '@ema-agent/turn';
import type { ContextRuntimeEvent } from '../events.js';
import type { LanguageModel, LlmToolDef, Message } from '@ema-agent/llm';
import type { HookBus } from '@ema-agent/hooks';

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
  executionProfile: ExecutionProfile;
  narrativePolicy: NarrativePolicy;
  messages: Message[];
  /** Prompt 等固定前缀参与预算，但不得进入摘要模型。 */
  prefixMessages?: readonly Message[];
  /** 临时召回与当前 Turn 参与预算并原样保留，但不得进入摘要模型。 */
  suffixMessages?: readonly Message[];
  /** Provider 已明确报告超限时跳过估算阈值，强制尝试安全压缩。 */
  force?: boolean;
  modelContextWindow: number;
  modelMaxOutputTokens?: number;
  tools?: readonly LlmToolDef[];
  providerId: string;
  model: string;
  signal?: AbortSignal;
  emit?: (event: ContextRuntimeEvent) => void;
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
      reason: 'hook_aborted' | 'circuit_open';
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
