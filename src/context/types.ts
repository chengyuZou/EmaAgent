import type { Message, LlmToolDef } from '@ema-agent/llm';
import type { PromptSnapshot } from '@ema-agent/prompts';
import type { ToolManifestSnapshot } from '@ema-agent/tools';
import type { SessionId, TurnId, TurnMode } from '@ema-agent/contracts';
import type { EmaStreamEvent } from '@ema-agent/turn';

export type ContextContributionSource =
  | 'memory'
  | 'narrative'
  | 'scratchpad'
  | 'mailbox';

export type ContextContributionPlacement =
  | 'beforeCurrentTurn'
  | 'afterCurrentTurn';

/** 本轮临时上下文拥有明确来源和位置，不得混入可持久化、可压缩的会话历史。 */
export interface ContextContribution {
  readonly id: string;
  readonly source: ContextContributionSource;
  readonly placement: ContextContributionPlacement;
  readonly message: Message;
}

export interface ContextAssemblyInput {
  readonly prompt: PromptSnapshot;
  readonly history: readonly Message[];
  /** 当前 Turn 可能已包含多轮 assistant/tool_result，因此不能假设只有一条 user message。 */
  readonly currentTurn: readonly Message[];
  readonly contributions?: readonly ContextContribution[];
  readonly toolManifest?: ToolManifestSnapshot;
}

/** 一次模型调用看到的完整只读快照，也是缓存诊断使用的版本事实。 */
export interface ModelContextSnapshot {
  readonly promptRevision: string;
  readonly toolManifestRevision: string | null;
  readonly messages: readonly Message[];
  /** 压缩后的可持久循环历史；Agent 下一次迭代复用它，避免重复生成摘要。 */
  readonly history: readonly Message[];
  readonly tools: readonly LlmToolDef[];
}

export interface ContextCompactionView {
  readonly prefixMessages: readonly Message[];
  readonly historyMessages: readonly Message[];
  readonly suffixMessages: readonly Message[];
  readonly tools: readonly LlmToolDef[];
}

export type ContextHistoryCompactor = (
  view: ContextCompactionView,
  options?: { readonly force?: boolean },
) => Promise<readonly Message[]>;

export interface ContextContributionRequest {
  readonly sessionId: SessionId;
  readonly turnId: TurnId;
  readonly mode: TurnMode;
  readonly userInput: string;
  readonly signal?: AbortSignal;
  readonly emit?: (event: EmaStreamEvent) => void;
}

export type ContextContributionProvider = (
  request: ContextContributionRequest,
) => Promise<readonly ContextContribution[]>;
