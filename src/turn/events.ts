// 定义一次 Turn 自身的生命周期、模型输出投影与请求降级事件。
import type { AgentRunEvent } from '@ema-agent/agent';
import type { CompactEvent } from '@ema-agent/compact';
import type { NarrativeEvent } from '@ema-agent/narrative';
import type {
  PermissionRequiredEvent,
  PermissionResolvedEvent,
} from '@ema-agent/permission';
import type { ToolExecutionEvent } from '@ema-agent/tools';
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
  | {
      type: 'agent_iteration';
      sessionId: string;
      turnId: string;
      n: number;
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

/**
 * AgentRun 事件进入 Turn 事件流时补上根身份（agent 包不感知 sessionId/turnId）。
 */
export type TurnAgentRunEvent = AgentRunEvent & {
  readonly sessionId: string;
  readonly turnId: string;
};

/**
 * 根 Turn 事件流的全部成员。各域事件由拥有方定义（turn/agent/tools/permission/
 * compact/narrative），这里只做流组合，不重复声明；AgentLoop 事件经执行器翻译为
 * 带身份的 TurnEvent 成员后入流。Narrative 召回发生在 Turn 内（每 Turn 至多一次），
 * 其生命周期事件随本 Turn 事件流有序到达。
 */
export type TurnStreamEvent =
  | TurnEvent
  | TurnAgentRunEvent
  | ToolExecutionEvent
  | PermissionRequiredEvent
  | PermissionResolvedEvent
  | CompactEvent
  | NarrativeEvent;
