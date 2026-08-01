// 定义上下文压缩过程向当前 Turn 公开的业务事件。
import type { CompactionId, SessionId, TurnId } from '@ema-agent/ids';
import type { LlmCallId } from '@ema-agent/llm';
import type { ExecutionProfile, NarrativePolicy } from '@ema-agent/turn';
import type { ContextUsageEstimate } from './contextUsage.js';

interface ContextCompactionEventBase {
  compactionId: CompactionId;
  sessionId: SessionId;
  turnId: TurnId;
  executionProfile: ExecutionProfile;
  narrativePolicy: NarrativePolicy;
  beforeTokens: number;
}

export type ContextEvent =
  | ({ type: 'context_compaction_started' } & ContextCompactionEventBase)
  | ({ type: 'context_compaction_completed'; afterTokens: number; savedTokens: number; durationMs: number } & ContextCompactionEventBase)
  | ({ type: 'context_compaction_failed'; error: string; afterTokens: number; durationMs: number } & ContextCompactionEventBase)
  | {
      readonly type: 'llm_context_prepared';
      readonly sessionId: SessionId;
      readonly turnId: TurnId;
      readonly llmCallId: LlmCallId;
      readonly estimate: ContextUsageEstimate;
    };

/** Context 压缩运行时只转发 Context 自己拥有的领域事件。 */
export type ContextRuntimeEvent = ContextEvent;
