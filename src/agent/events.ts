import type {
  LlmGenerationSource,
  LlmCallStatus,
  LlmStopReason,
  LlmThinkingState,
  LlmTokenUsage,
  AssistantBlock,
  Message,
} from '@ema-agent/llm';
import type { ToolResult } from '@ema-agent/tools';
import type { SubagentMessage, SubagentRun } from './subagents/types.js';
import type { AgentLoopState } from './agentLoopState.js';

export type AgentLoopEvent =
  | {
    readonly type: 'iteration_started';
    readonly iteration: number;
    readonly continuesOutput: boolean;
    readonly state: AgentLoopState;
  }
  | { readonly type: 'text_delta'; readonly blockIndex: number; readonly delta: string }
  | {
    readonly type: 'thinking_delta';
    readonly blockIndex: number;
    readonly delta: string
  }
  | {
    readonly type: 'thinking_completed';
    readonly blockIndex: number;
    /** 协议原生推理状态(signature/id/thoughtSignature)缺失 = 无续接状态 */
    readonly state?: LlmThinkingState;
  }
  | {
    readonly type: 'tool_use_partial';
    readonly blockIndex: number;
    readonly toolCallId: string;
    readonly toolName: string;
    readonly argsDelta: string;
  }
  | {
    readonly type: 'tool_use_completed';
    readonly blockIndex: number;
    readonly toolCallId: string;
    readonly toolName: string;
    readonly args: unknown;
  }
  | {
    readonly type: 'llm_call_usage_updated';
    readonly llmCallId: string;
    readonly usage: LlmTokenUsage;
  }
  | { readonly type: 'agent_usage_updated'; readonly usage: LlmTokenUsage }
  | {
    readonly type: 'llm_call_finished';
    readonly llmCallId: string;
    readonly source: LlmGenerationSource;
    readonly status: LlmCallStatus;
    readonly usage?: LlmTokenUsage;
    readonly startedAt: number;
    readonly durationMs: number;
    readonly errorCode?: string;
  }
  | {
    readonly type: 'assistant_message_completed';
    readonly iteration: number;
    readonly llmCallId: string;
    readonly stopReason: LlmStopReason;
    /** Provider 本轮闭合后的完整消息块. 持久化方以此为边界, 不自行拼接流式 delta. */
    readonly content: readonly AssistantBlock[];
  }
  | {
    /** AgentLoop 已把这些消息追加进下一次调用会读取的工作历史。 */
    readonly type: 'model_history_appended';
    readonly llmCallId: string;
    readonly messages: readonly Message[];
  }
  | { readonly type: 'tool_result'; readonly result: ToolResult }
  | { readonly type: 'phase_changed'; readonly state: AgentLoopState }
  | {
    readonly type: 'loop_stopped';
    readonly finalText: string;
    readonly state: AgentLoopState;
  };

/** Session 子代理事件直接携带本次 Run 与真实消息, 不依赖父 Turn. */
export type SubagentEvent =
  | {
    readonly type: 'subagent_started';
    readonly subagentId: string;
    readonly runId: string;
    readonly parentToolCallId: string;
    readonly startedAt: number;
  }
  | {
    readonly type: 'iteration_started';
    readonly subagentId: string;
    readonly runId: string;
    readonly iteration: number;
    readonly continuesOutput: boolean;
    /** 当前 Run 已准备好的实际配置, 面板不猜测身份的最近模型. */
    readonly run: SubagentRun;
  }
  | {
    readonly type: 'message_updated';
    readonly subagentId: string;
    readonly runId: string;
    /** 已落库的同一 Message; 后续文本/闭合/中断仍更新这个 ID. */
    readonly message: SubagentMessage;
    /** delta 为 true, Assistant 闭合或中断后为 false, 用于思考/正文生成状态. */
    readonly streaming: boolean;
  }
  | {
    readonly type: 'tool_progress';
    readonly subagentId: string;
    readonly runId: string;
    readonly toolCallId: string;
    readonly progress: unknown;
  }
  | {
    readonly type: 'tool_result';
    readonly subagentId: string;
    readonly runId: string;
    /** 工作区变更等旁路消费者直接按真实工具名刷新, 不扫描消息正文. */
    readonly toolName: string;
    readonly result: ToolResult;
  }
  | {
    readonly type: 'subagent_completed' | 'subagent_failed' | 'subagent_aborted';
    readonly subagentId: string;
    readonly runId: string;
    /** 先提交 SQL 终态, 再发布这条执行事实. */
    readonly run: SubagentRun;
  };
