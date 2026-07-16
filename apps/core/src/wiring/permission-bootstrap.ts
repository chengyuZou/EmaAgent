// 这里根据运行模式创建权限引擎，并装入内置工具的默认权限规则。
/**
 * permission-bootstrap.ts — PermissionEngine construction + per-turn ask factory.
 *
 * Extracted from bindings.ts to keep the DI assembly file focused.
 * Pattern matches tts.ts / stt.ts / llm-providers.ts.
 */

import { PermissionEngine } from '@ema-agent/permission';
import type { AskPermissionFn } from '@ema-agent/permission';
import type { EmaStreamEvent, SessionId, ToolCallId, TurnId } from '@ema-agent/contracts';
import { PermissionPromptRegistry } from '../permissions/registry.js';
import { AskUserRegistry } from '../ask-user/registry.js';
import type { SettingsRepo } from '@ema-agent/storage';
import { BuiltinTools } from '@ema-agent/tool-builtin';

// ── Result type ───────────────────────────────────────────────────────────────

export interface PermissionBootstrapResult {
  permission:        PermissionEngine;
  permissionPrompts: PermissionPromptRegistry;
  askUserRegistry:   AskUserRegistry;
  buildAskForTurn: (args: {
    sessionId: string;
    turnId:    TurnId;
    toolCallId: ToolCallId;
    emit:      (ev: EmaStreamEvent) => void;
  }) => AskPermissionFn;
}

// ── Builder ───────────────────────────────────────────────────────────────────

/**
 * Construct the permission subsystem.
 *
 * PermissionEngine operates in 'ask' mode by default — every write/execute
 * tool surfaces a confirmation dialog. Set AGEN_PERMISSION_BYPASS=1 to skip
 * all prompts (automated tests / power-user CLI use only).
 *
 * Read、Glob、Grep 使用稳定内部 id 预授权，模型展示名称以后变化也不会丢规则。
 */
export function buildPermissionSubsystem(settingsRepo: SettingsRepo): PermissionBootstrapResult {
  // Timeout from persistent settings; falls back to 120 s.
  const storedTimeout = settingsRepo.get('permission.askTimeoutMs');
  const permissionPrompts = new PermissionPromptRegistry(
    typeof storedTimeout === 'number' ? storedTimeout : 120_000,
  );

  // Dev mode: 5 s timeout so a missing frontend doesn't stall the turn for 2 min.
  const askUserTimeoutMs = process.env['NODE_ENV'] === 'development' ? 5_000 : 120_000;
  const askUserRegistry  = new AskUserRegistry(askUserTimeoutMs);

  const permissionMode = process.env['AGEN_PERMISSION_BYPASS'] === '1' ? 'bypass' : 'ask';
  const permission = new PermissionEngine({
    mode: permissionMode,
    rules: [
      // Read-only tools: no side effects, no prompt fatigue.
      { tool: BuiltinTools.FileRead.id, action: 'allow', scope: 'global' },
      { tool: BuiltinTools.Glob.id,     action: 'allow', scope: 'global' },
      { tool: BuiltinTools.Grep.id,     action: 'allow', scope: 'global' },
    ],
    // Placeholder — replaced per-turn by buildAskForTurn below.
    ask: async () => ({ action: 'deny', reason: 'no per-turn ask wired' }),
  });

  const buildAskForTurn = (args: {
    sessionId: string;
    turnId:    TurnId;
    toolCallId: ToolCallId;
    emit:      (ev: EmaStreamEvent) => void;
  }): AskPermissionFn => {
    return async (prompt) => {
      const { promptId, promise } = permissionPrompts.create({
        sessionId: args.sessionId,
        turnId:    args.turnId,
        toolCallId: args.toolCallId,
      });
      args.emit({
        type:      'permission_required',
        sessionId: args.sessionId as SessionId,
        turnId:    args.turnId,
        callId:    args.toolCallId,
        promptId,
        tool:      prompt.toolName,
        args:      prompt.input,
        hint:      prompt.gateReason ?? '',
      });
      const response = await promise;
      args.emit({
        type:      'permission_resolved',
        sessionId: args.sessionId as SessionId,
        turnId:    args.turnId,
        callId:    args.toolCallId,
        promptId,
        decision: response.action === 'allow' || response.action === 'allow_session'
                  ? 'allow' : 'deny',
      });
      return response;
    };
  };

  return { permission, permissionPrompts, askUserRegistry, buildAskForTurn };
}
