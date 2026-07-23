// 定义一次 Turn 自身的生命周期、模型输出投影与请求降级事件。
import type { SessionId, TurnId } from '@ema-agent/ids';
import type { TurnFailureCode } from './errors.js';
import type { ExecutionProfile, NarrativePolicy, TurnStats } from './turns.js';

export type { TurnStats };

/** 请求在调用 Provider 前执行的可观测兼容降级。 */
export interface RequestDegradationNotice {
  attempt: number;
  reason: string;
  removed: Array<'image' | 'audio' | 'file' | 'parameter'>;
  replacements: Array<'description' | 'placeholder' | 'parameter_omitted'>;
}

export type TurnEvent =
  | {
      type: 'turn_started';
      sessionId: SessionId;
      turnId: TurnId;
      executionProfile: ExecutionProfile;
      narrativePolicy: NarrativePolicy;
    }
  | {
      type: 'usage_update';
      sessionId: SessionId;
      turnId: TurnId;
      inputTokens: number;
      outputTokens: number;
    }
  | {
      type: 'turn_completed';
      sessionId: SessionId;
      turnId: TurnId;
      stats: TurnStats;
    }
  | {
      type: 'turn_failed';
      sessionId: SessionId;
      turnId: TurnId;
      code: TurnFailureCode;
      message: string;
    }
  | {
      type: 'turn_aborted';
      sessionId: SessionId;
      turnId: TurnId;
      reason: string;
    }
  | {
      type: 'turn_projection_warning';
      sessionId: SessionId;
      turnId: TurnId;
      projection: 'subagent_transcript' | 'turn_audio';
      code: string;
      message: string;
      retryable: boolean;
    }
  | ({
      type: 'request_degraded';
      sessionId: SessionId;
      turnId: TurnId;
    } & RequestDegradationNotice)
  | {
      type: 'output_text_delta';
      sessionId: SessionId;
      blockIndex: number;
      delta: string;
    }
  | {
      type: 'reasoning_delta';
      sessionId: SessionId;
      blockIndex: number;
      delta: string;
    }
  | {
      type: 'reasoning_complete';
      sessionId: SessionId;
      blockIndex: number;
    };
