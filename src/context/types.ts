import type { Message, LlmToolDef } from '@ema-agent/llm';
import type { SessionId, TurnId } from '@ema-agent/contracts';
import type {
  EmaStreamEvent,
  ExecutionProfile,
  NarrativePolicy,
} from '@ema-agent/turn';

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
  readonly executionProfile: ExecutionProfile;
  readonly narrativePolicy: NarrativePolicy;
  readonly userInput: string;
  readonly signal?: AbortSignal;
  readonly emit?: (event: EmaStreamEvent) => void;
}

export type ContextContributionProvider = (
  request: ContextContributionRequest,
) => Promise<readonly ContextContribution[]>;
