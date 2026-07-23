// 定义上下文压缩过程向当前 Turn 公开的业务事件。
import type { CompactionId, SessionId, TurnId } from '@ema-agent/ids';
import type { ExecutionProfile, NarrativePolicy } from '@ema-agent/turn';
import type { HookWarningEvent } from '@ema-agent/hooks';

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
  | ({ type: 'context_compaction_skipped'; reason: 'hook_aborted'; message: string; afterTokens: number; durationMs: number } & ContextCompactionEventBase);

/** Context 压缩运行时会同时转发 HookBus 自有的告警事件。 */
export type ContextRuntimeEvent = ContextEvent | HookWarningEvent;
