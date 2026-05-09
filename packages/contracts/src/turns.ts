import type { SessionId, TurnId, TurnMode, AgentSubMode, TurnStatus } from './ids.js';

export interface TurnRequest {
  id: TurnId;
  sessionId: SessionId;
  mode: TurnMode;
  agentSubMode?: AgentSubMode;
  userInput: string;
  model?: string;
  attachments?: unknown[];
}

export interface UsageSummary {
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
  durationMs: number;
}

export interface TurnState {
  id: TurnId;
  sessionId: SessionId;
  mode: TurnMode;
  subMode?: AgentSubMode;
  status: TurnStatus;
}
