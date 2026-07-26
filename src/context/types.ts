import type { Message, LlmToolDef } from '@ema-agent/llm';
import type { SessionId, TurnId } from '@ema-agent/ids';
import type { ExecutionProfile, NarrativePolicy } from '@ema-agent/turn';

export type ContextContributionSource =
  | 'memory'
  | 'narrative'
  | 'scratchpad'
  | 'mailbox'
  | 'tasks'
  | 'skills';

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

export interface ContextCompactionView {
  readonly prefixMessages: readonly Message[];
  readonly historyMessages: readonly Message[];
  readonly suffixMessages: readonly Message[];
  /** Macro 后必须恢复的 Agent 运行态；预算不足时压缩失败，不能静默丢弃。 */
  readonly requiredRestoreMessages: readonly Message[];
  readonly tools: readonly LlmToolDef[];
}

export type ContextHistoryCompactor = (
  view: ContextCompactionView,
  options?: { readonly force?: boolean },
) => Promise<readonly Message[]>;

export interface ContextContributionRequest<TEvent = never> {
  readonly sessionId: SessionId;
  readonly turnId: TurnId;
  readonly executionProfile: ExecutionProfile;
  readonly narrativePolicy: NarrativePolicy;
  readonly userInput: string;
  readonly signal?: AbortSignal;
  /** Contribution 业务域可选的观察事件；Context 不拥有其联合类型。 */
  readonly emit?: (event: TEvent) => void;
}

export type ContextContributionProvider<TEvent = never> = (
  request: ContextContributionRequest<TEvent>,
) => Promise<readonly ContextContribution[]>;
