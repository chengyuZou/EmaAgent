// 定义一次 Turn 自身的生命周期、模型输出投影与请求降级事件。
import type {
  ExecutionProfile,
  NarrativePolicy,
  RequestDegradationNotice,
  TurnFailureCode,
  TurnStats,
} from '@ema-agent/turn-terms';

export type TurnEvent =
  | {
      type: 'turn_started';
      sessionId: string;
      turnId: string;
      executionProfile: ExecutionProfile;
      narrativePolicy: NarrativePolicy;
    }
  | {
      type: 'usage_update';
      sessionId: string;
      turnId: string;
      inputTokens: number;
      outputTokens: number;
    }
  | {
      type: 'turn_completed';
      sessionId: string;
      turnId: string;
      stats: TurnStats;
    }
  | {
      type: 'turn_failed';
      sessionId: string;
      turnId: string;
      code: TurnFailureCode;
      message: string;
    }
  | {
      type: 'turn_aborted';
      sessionId: string;
      turnId: string;
      reason: string;
    }
  | {
      type: 'turn_projection_warning';
      sessionId: string;
      turnId: string;
      projection: 'subagent_transcript' | 'turn_audio';
      code: string;
      message: string;
      retryable: boolean;
    }
  | ({
      type: 'request_degraded';
      sessionId: string;
      turnId: string;
    } & RequestDegradationNotice)
  | {
      type: 'output_text_delta';
      sessionId: string;
      turnId: string;
      blockIndex: number;
      delta: string;
    }
  | {
      type: 'reasoning_delta';
      sessionId: string;
      turnId: string;
      blockIndex: number;
      delta: string;
    }
  | {
      type: 'reasoning_complete';
      sessionId: string;
      turnId: string;
      blockIndex: number;
    };
