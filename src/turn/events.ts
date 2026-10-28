import type { CompactEvent } from '@ema-agent/compact';
import type { ContextUsage } from '@ema-agent/context';
import type { LLMTokenUsage } from '@ema-agent/llm';
import type { StageStreamEvent } from '@ema-agent/stage';
import type { ToolExecutionEvent } from '@ema-agent/tools';
import type { SessionMessage } from '@ema-agent/session';
import type { TurnFailureCode } from './errors.js';
import type { RequestDegradationNotice, TurnTriggerType } from './types.js';

export type TurnEvent =
  | {
    /**
     * UserMessage 已经成功写入 Session History. message 是持久化后的真实记录,
     * 其中已包含 Message ID, Session ID, Turn ID 和写入时间, 事件外层不重复这些字段.
     */
    readonly type: 'user_message_stored';
    readonly message: SessionMessage;
    /** 这些排队输入已合入 message, 前端用它移除等待显示. 不写入 SQL. */
    readonly queuedInputIds: readonly string[];
  }
  | {
    type: 'turn_started';
    sessionId: string;
    turnId: string;
    triggerType: TurnTriggerType;
    /** 与 Turn 行同源的本轮语音选择, 不代表语音管线已经成功启动. */
    ttsEnabled: boolean;
  }
  | {
    readonly type: 'context_usage_updated';
    readonly sessionId: string;
    readonly turnId: string;
    readonly llmCallId: string;
    readonly usage: ContextUsage;
  }
  | {
    readonly type: 'agent_usage_updated';
    readonly sessionId: string;
    readonly turnId: string;
    readonly usage: LLMTokenUsage;
  }
  | { type: 'turn_completed'; sessionId: string; turnId: string }
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
    assistantMessageId: string;
  }
  | ({ type: 'request_degraded'; sessionId: string; turnId: string } & RequestDegradationNotice)
  | {
    type: 'output_text_delta';
    sessionId: string;
    turnId: string;
    blockIndex: number;
    delta: string;
    assistantMessageId: string;
  }
  | {
    type: 'reasoning_delta';
    sessionId: string;
    turnId: string;
    blockIndex: number;
    delta: string;
    assistantMessageId: string;
  }
  | {
    type: 'reasoning_complete';
    sessionId: string;
    turnId: string;
    blockIndex: number;
    assistantMessageId: string;
  }
  | {
    type: 'tool_call_partial';
    sessionId: string;
    turnId: string;
    blockIndex: number;
    callId: string;
    name: string;
    argsDelta: string;
    assistantMessageId: string;
  }
  | {
    type: 'tool_call_complete';
    sessionId: string;
    turnId: string;
    blockIndex: number;
    callId: string;
    name: string;
    args: unknown;
    assistantMessageId: string;
  };

/** 自动 Compact 事件进入 Turn 事件流时补上本 Turn 身份; Compact 包自身不感知 Turn. */
export type TurnCompactEvent = CompactEvent & { readonly turnId: string };

/**
 * Turn 事件流的全部成员. Permission 独立走 Session 出口, 不依赖父 Turn.
 * 各域事件由拥有方定义(turn/tools/
 * compact/stage), 这里只做流组合, 不重复声明; AgentLoop 事件经执行器翻译为
 * 带身份的 TurnEvent 成员后入流.Stage 事件由正文标签清洗顺带产出,
 * 与引发它的正文 delta 保持先后顺序.
 */
export type TurnStreamEvent =
  | TurnEvent
  | ToolExecutionEvent
  | TurnCompactEvent
  | StageStreamEvent;
