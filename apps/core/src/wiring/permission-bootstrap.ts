// 这里根据运行模式创建权限引擎，并装入内置工具的默认权限规则。
/**
 * permission-bootstrap.ts — PermissionEngine construction + per-turn ask factory.
 *
 * Extracted from bindings.ts to keep the DI assembly file focused.
 * Pattern matches tts.ts / stt.ts / llm-providers.ts.
 */

import { PermissionEngine } from '@ema-agent/permission';
import type { AskPermissionFn } from '@ema-agent/permission';
import type { SessionId, ToolCallId, TurnId } from '@ema-agent/ids';
import type { PermissionStreamEvent } from '@ema-agent/permission';
import { PermissionPromptRegistry } from '../permissions/registry.js';
import { AskUserRegistry } from '../ask-user/registry.js';
import type { SettingsRepo } from '@ema-agent/storage';

// ── Result type ───────────────────────────────────────────────────────────────

export interface PermissionBootstrapResult {
  permission:        PermissionEngine;
  permissionPrompts: PermissionPromptRegistry;
  askUserRegistry:   AskUserRegistry;
  buildAskForTurn: (args: {
    sessionId: string;
    turnId:    TurnId;
    toolCallId: ToolCallId;
    emit:      (ev: PermissionStreamEvent) => void;
  }) => AskPermissionFn;
}

// ── Builder ───────────────────────────────────────────────────────────────────

/**
 * 构造权限子系统。
 *
 * PermissionEngine 默认 'ask' 模式——每次写/执行工具都弹确认。
 * AGEN_PERMISSION_BYPASS=1 仅在非生产构建(NODE_ENV !== production)生效,
 * 用于自动化测试或开发者 CLI;生产构建物理拒绝该环境变量。
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

  // 正式构建(NODE_ENV=production)物理拒绝 bypass,防止用户用环境变量绕过权限。
  // 仅开发/测试构建允许 AGEN_PERMISSION_BYPASS=1。
  const bypassAllowed = process.env['NODE_ENV'] !== 'production';
  const permissionMode = bypassAllowed && process.env['AGEN_PERMISSION_BYPASS'] === '1'
    ? 'bypass'
    : 'ask';
  const permission = new PermissionEngine({
    mode: permissionMode,
    // 不为 FileRead/Glob/Grep 注入无路径限制的全局 allow:工作区内读取由
    // PermissionEngine 的 workingDir 规则自动放行,工作区外读取落到 ask,
    // 避免越界读取借 allow 规则提前通过。
    rules: [],
    // Placeholder — replaced per-turn by buildAskForTurn below.
    ask: async () => ({ action: 'deny', reason: 'no per-turn ask wired' }),
  });

  const buildAskForTurn = (args: {
    sessionId: string;
    turnId:    TurnId;
    toolCallId: ToolCallId;
    emit:      (ev: PermissionStreamEvent) => void;
  }): AskPermissionFn => {
    return async (prompt) => {
      const { promptId, promise } = permissionPrompts.create({
        sessionId: args.sessionId,
        turnId:    args.turnId,
        toolCallId: args.toolCallId,
        prompt,
      });
      args.emit({
        type:      'permission_required',
        sessionId: args.sessionId as SessionId,
        turnId:    args.turnId,
        callId:    args.toolCallId,
        promptId,
        toolId:    prompt.toolId,
        tool:      prompt.toolName,
        toolDescription: prompt.toolDescription,
        args:      prompt.input,
        hint:      prompt.gateReason ?? '',
        riskLevel: prompt.riskLevel,
        accessType: prompt.accessType,
        gateReason: prompt.gateReason,
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
