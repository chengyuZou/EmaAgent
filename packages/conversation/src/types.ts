// 这里放 ConversationEngine 的依赖接口和单次运行的输入类型。

import type { RequestDegradationNotice, SessionId, TurnMode } from '@ema-agent/contracts';
import type {
  LanguageModel,
  LlmContentPart,
  Message as ModelMessage,
  ThinkingMode,
} from '@ema-agent/llm';
import type { SessionStore, Turn } from '@ema-agent/session';
import type { HookBus } from '@ema-agent/hook';
import type { EmotionEngine } from '@ema-agent/emotion';
import type { NarrativeClient } from '@ema-agent/narrative-client';
import type { ModelCapabilityResolver } from '@ema-agent/provider';

// ── 依赖表面 ───────────────────────────────────────────────────────────────────

/**
 * ConversationEngine 需要的全部依赖--AppBindings 的严格子集。
 * apps/core（Hono sidecar）和未来的 CLI 都能满足这个接口，不用引入 HTTP 层概念。
 */
export interface ConversationDeps {
  session:       SessionStore;
  hooks:         HookBus;
  llm:           LanguageModel;
  modelCapabilities: ModelCapabilityResolver;
  emotion:       EmotionEngine;
  narrative:     NarrativeClient;
}

// ── 运行输入 ───────────────────────────────────────────────────────────────────

export interface ConversationRunInput {
  /** 已开始的 turn（调用方负责 session.startTurn）。 */
  turn:          Turn;
  /** 从 session.startTurn 接来的 abort signal，用户点 Stop 时触发。 */
  signal:        AbortSignal;
  sessionId:     SessionId;
  /** 'chat' 或 'narrative'；agent 由 AgentEngine 处理。 */
  mode:          Exclude<TurnMode, 'agent'>;
  userInput:     string;
  contentParts?: LlmContentPart[];
  /** provider_configs.id--由 orchestrator 从请求或旧绑定解析。 */
  providerId?:   string;
  /** 模型名--由 orchestrator 从请求或旧绑定解析。 */
  model?:        string;
  /** 每次逻辑推理前压缩原始历史；由 Orchestrator 注入 Memory Facade。 */
  compactMessages?: (messages: ModelMessage[]) => Promise<ModelMessage[]>;
  /** 用户请求的 thinking 模式，直接透传给 LlmRequest。 */
  thinking?:     ThinkingMode;
  /** Core 在 Engine 前完成的图片描述等降级，用结构化 SSE 告知前端。 */
  requestDegradations?: RequestDegradationNotice[];
}
