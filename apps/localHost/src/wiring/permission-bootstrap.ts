// 根据运行模式创建权限引擎，并让 Permission 与 AskUser 共享 Session 交互队列。

import { PermissionEngine, SqlPermissionRuleStore } from '@ema-agent/permission';
import type {
  AskPermissionFn,
  PermissionPrompt,
  PermissionResponse,
} from '@ema-agent/permission';
import type { SessionId, ToolCallId, TurnId } from '@ema-agent/ids';
import type { PermissionStreamEvent } from '@ema-agent/permission';
import type { AskUserRequiredEvent } from '@ema-agent/tools';
import {
  SessionInteractionQueue,
} from '@ema-agent/turn';
import type { AskUserInteractionOutcome } from '@ema-agent/turn';
import type { AskUserInteractionPort } from '@ema-agent/turn-execution';
import type { SqliteDb } from '@ema-agent/storage';

// ── 返回契约 ─────────────────────────────────────────────────────────────────

export type AppInteractionQueue = SessionInteractionQueue<
  PermissionPrompt,
  PermissionResponse,
  AskUserRequiredEvent
>;

export interface PermissionBootstrapResult {
  permission:        PermissionEngine;
  /** Permission 与 AskUser 共享的 per-Session FIFO 交互队列。 */
  interactionQueue:  AppInteractionQueue;
  /** 适配根 Turn AskUser 等待的交互端口；内部委托统一队列。 */
  askUserRegistry:   AskUserInteractionPort;
  buildAskForTurn: (args: {
    sessionId: string;
    turnId:    TurnId;
    toolCallId: ToolCallId;
    emit:      (ev: PermissionStreamEvent) => void;
  }) => AskPermissionFn;
}

// ── AskUser 交互端口适配器 ──────────────────────────────────────────────────

/**
 * 把 TurnExecutor 的 AskUser 等待接到统一交互队列。
 *
 * 执行器调用 createWithId(promptId, timeoutMs, turnId, request)；request 携带
 * sessionId(见 tools/events.ts 的 ask_*_required 事件),适配器据此把问询推入
 * 对应 Session 的 FIFO,与 Permission 共同排队。
 */
class InteractionQueueAskUserAdapter implements AskUserInteractionPort {
  constructor(private readonly queue: AppInteractionQueue) {}

  createWithId(
    promptId: string,
    timeoutMs?: number,
    turnId?: string,
    request?: AskUserRequiredEvent,
  ): { promise: Promise<AskUserInteractionOutcome> } {
    if (!turnId) {
      throw new Error('AskUser createWithId requires turnId');
    }
    if (!request) {
      throw new Error('AskUser createWithId requires request');
    }
    // ask_*_required 事件均携带 sessionId(tools/events.ts);统一队列按 Session FIFO。
    const sessionId = request.sessionId as string;
    const { promise } = this.queue.enqueueAskUser({
      promptId,
      sessionId,
      turnId,
      request,
      timeoutMs,
    });
    return { promise };
  }

  cancel(promptId: string): boolean {
    return this.queue.cancel(promptId, 'ask-user cancelled');
  }
}

// ── 子系统装配 ───────────────────────────────────────────────────────────────

/**
 * 构造权限子系统。
 *
 * PermissionEngine 默认 'ask' 模式——每次写/执行工具都弹确认。
 * AGEN_PERMISSION_BYPASS=1 仅在非生产构建(NODE_ENV !== production)生效,
 * 用于自动化测试或开发者 CLI;生产构建物理拒绝该环境变量。
 *
 * 永久规则存 profile.db.permission_rules,通过 SqlPermissionRuleStore 适配;
 * 启动时 PermissionEngine 从 Store 加载已启用规则参与匹配,addRule/removeRule/setRuleEnabled
 * 会立即写库并刷新内存快照。内置规则由代码提供,不进数据库。
 */
export function buildPermissionSubsystem(
  defaultTimeoutMs: number,
  profileDb:    SqliteDb,
): PermissionBootstrapResult {
  // 用户设置只影响新入队的交互，已经开始等待的条目保持原超时。
  const interactionQueue = new SessionInteractionQueue<
    PermissionPrompt,
    PermissionResponse,
    AskUserRequiredEvent
  >(
    defaultTimeoutMs,
    reason => ({ action: 'deny', reason }),
  );

  const askUserRegistry = new InteractionQueueAskUserAdapter(interactionQueue);

  // 正式构建(NODE_ENV=production)物理拒绝 bypass,防止用户用环境变量绕过权限。
  // 仅开发/测试构建允许 AGEN_PERMISSION_BYPASS=1。
  const bypassAllowed = process.env['NODE_ENV'] !== 'production';
  const permissionMode = bypassAllowed && process.env['AGEN_PERMISSION_BYPASS'] === '1'
    ? 'bypass'
    : 'ask';

  // 永久规则 Store:profile.db.permission_rules。
  // 不为 FileRead/Glob/Grep 注入无路径限制的全局 allow:工作区内读取由
  // PermissionEngine 的 workingDir 规则自动放行,工作区外读取落到 ask,
  // 避免越界读取借 allow 规则提前通过。
  const ruleStore = new SqlPermissionRuleStore(profileDb);
  const permission = new PermissionEngine({
    mode: permissionMode,
    ask:  async () => ({ action: 'deny', reason: 'no per-turn ask wired' }),
  }, ruleStore);

  const buildAskForTurn = (args: {
    sessionId: string;
    turnId:    TurnId;
    toolCallId: ToolCallId;
    emit:      (ev: PermissionStreamEvent) => void;
  }): AskPermissionFn => {
    return async (prompt) => {
      const { promptId, promise } = interactionQueue.enqueuePermission({
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

  return { permission, interactionQueue, askUserRegistry, buildAskForTurn };
}
