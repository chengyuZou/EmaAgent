import type { SessionId, AgentSubMode } from '@ema-agent/contracts';
import type { LlmRouter, LlmContentPart } from '@ema-agent/llm';
import type { SessionStore, Turn } from '@ema-agent/session';
import type { HookBus } from '@ema-agent/hook';
import type { EmotionEngine } from '@ema-agent/emotion';
import type { ICommandRunner, ToolRegistry } from '@ema-agent/tool';
import type { PermissionEngine } from '@ema-agent/permission';
import type { ModelBindingsRepo } from '@ema-agent/storage';

// ── Dependency surface ────────────────────────────────────────────────────────

/**
 * Everything AgentEngine needs — a strict subset of AppBindings.
 * No imports from ConversationEngine; the two engines share nothing but types.
 */
export interface AgentDeps {
  session:        SessionStore;
  hooks:          HookBus;
  llm:            LlmRouter;
  emotion:        EmotionEngine;
  tools:          ToolRegistry;
  permission:     PermissionEngine;
  modelBindings:  ModelBindingsRepo;
  /**
   * Per-session sandbox runner factory. Returning undefined disables sandboxing
   * (bash will spawn directly via spawnProcess). The orchestrator caches one
   * CommandRunner per sessionId — workspaceRoot differs across sessions so a
   * singleton wouldn't work. Optional so tests can omit it entirely.
   */
  getCommandRunner?: (sessionId: SessionId) => ICommandRunner | undefined;
  /**
   * Direct command-runner pass-through. Used by simple/single-session embedders
   * (tests, CLI one-shot). Takes precedence over getCommandRunner when set.
   */
  commandRunner?: ICommandRunner;
}

// ── Run input ─────────────────────────────────────────────────────────────────

export interface AgentRunInput {
  /** Already-started turn (caller is responsible for session.startTurn). */
  turn:                  Turn;
  /** Abort signal wired from session.startTurn — fires on user Stop. */
  signal:                AbortSignal;
  sessionId:             SessionId;
  subMode:               AgentSubMode;
  userInput:             string;
  contentParts?:         LlmContentPart[];
  /** Pre-built system prompt (assembled by orchestrator from character card + mode block). */
  systemPrompt:          string;
  /** Absolute path to the user's active workspace root. */
  workspaceRoot:         string;
  additionalWorkingDirs?: string[];
  /** Explicit model override; falls back to model_bindings → firstProviderId. */
  model?:                string;
}
