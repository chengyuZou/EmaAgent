/**
 * 会话服务：对外的会话生命周期管理。
 */

import type {
  ChatMessage,
  CreateTurnInput,
  EmaMode,
  EmaTurnMetadata,
  ListMessagesOptions,
  ListTurnsOptions,
  MessagePage,
  SessionState,
  SessionSummary,
  SessionTitleStatus,
  TurnPage,
  TurnRecord,
  TurnStatus,
  UsageView,
} from "@ema-agent/core-types";
import { getSessionRepository } from "./session-repo.js";

export interface GetMessageOptions {
  includeSystem?: boolean;
  includeTool?: boolean;
  limit?: number;
}

/** 创建会话时的业务输入。 */
export interface CreateSessionRequest {
  sessionId: string;
  title?: string;
  modeLast?: EmaMode;
}

/** 完成 turn 时传入的运行统计。 */
export interface CompleteTurnRequest {
  requestId: string;
  usage?: UsageView;
  modelId?: string;
  providerId?: string;
  endedAt?: number;
}

/**
 * 获取或创建会话。
 */
export async function getOrCreateSession(sessionId: string): Promise<SessionState> {
  const repo = getSessionRepository();
  const existing = await repo.getById(sessionId);
  if (existing) return existing;

  return repo.create({ id: sessionId });
}

/** 显式创建会话，供未来 POST /api/sessions 使用。 */
export async function createSession(req: CreateSessionRequest): Promise<SessionState> {
  const repo = getSessionRepository();
  const existing = await repo.getById(req.sessionId);
  if (existing) {
    return existing;
  }

  return repo.create({
    id: req.sessionId,
    title: req.title,
    modeLast: req.modeLast,
  });
}

/**
 * 追加消息到会话。
 */
export async function appendMessage(sessionId: string, msg: ChatMessage): Promise<void> {
  const repo = getSessionRepository();
  await getOrCreateSession(sessionId);
  await repo.appendMessage(sessionId, msg);
}

/**
 * 写入轮次元信息（用于后续调试与审计）。
 */
export async function markTurnMetadata(
  sessionId: string,
  requestId: string,
  metadata: EmaTurnMetadata,
): Promise<void> {
  const repo = getSessionRepository();
  const existing = await repo.getTurnById(requestId);

  if (!existing) {
    await repo.createTurn({
      requestId,
      sessionId,
      mode: metadata.mode,
      status: "completed",
      modelId: metadata.model.modelId,
      providerId: metadata.model.provider,
      startedAt: Date.now() - metadata.latencyMs,
    });
  }

  await repo.updateTurn({
    requestId,
    status: "completed",
    modelId: metadata.model.modelId,
    providerId: metadata.model.provider,
    endedAt: Date.now(),
    usage: metadata.usage,
    costUsd: metadata.usage.costUsd,
  });
}

export async function listSessions(): Promise<SessionSummary[]> {
  const repo = getSessionRepository();
  return repo.list();
  
}

/**
 * 删除会话及其所有数据。
 */
export async function deleteSession(sessionId: string): Promise<void> {
  const repo = getSessionRepository();
  await repo.delete(sessionId);
}


/**
 * 获取会话消息，支持过滤。
 */
export async function getSessionMessages(
  sessionId: string,
  options: GetMessageOptions = {},
): Promise<ChatMessage[]> {
  const page = await getSessionMessagePage(sessionId, options);
  return page.items;
}

/** 分页获取会话消息，供 GET /api/sessions/:id/messages 使用。 */
export async function getSessionMessagePage(
  sessionId: string,
  options: ListMessagesOptions = {},
): Promise<MessagePage> {
  const repo = getSessionRepository();
  const session = await repo.getById(sessionId);
  if (!session) {
    throw new Error(`未找到会话: ${sessionId}`);
  }

  return repo.listMessages(sessionId, options);
}

const MAX_TITLE_LEN = 30;

/**
 * 根据首条用户消息自动设置会话标题。
 */
export async function autoRenameSession(sessionId: string): Promise<void> {
  const repo = getSessionRepository();
  const session = await repo.getById(sessionId);
  if (!session) return;

  // 找第一条用户信息
  const firstUserMsg = session.messages.find((msg) => msg.role === "user");
  if (!firstUserMsg) return;

  // 简单提取前 30 字作为标题
  const text = firstUserMsg.content.trim()
  if (!text) return;

  const title = text.length > MAX_TITLE_LEN ? text.slice(0, MAX_TITLE_LEN) + "..." : text;
  await repo.updateTitle(sessionId, title, "generated");
}

/** 手动更新会话标题。 */
export async function updateSessionTitle(
  sessionId: string,
  title: string,
  status: SessionTitleStatus = "manual",
): Promise<void> {
  const repo = getSessionRepository();
  await repo.updateTitle(sessionId, title, status);
}

/** 更新 session 的默认 mode；这不是固定会话类型，只是下一轮默认选择。 */
export async function updateSessionModeLast(sessionId: string, mode: EmaMode): Promise<void> {
  const repo = getSessionRepository();
  await repo.updateModeLast(sessionId, mode);
}

/** 创建一条 turn 记录，通常在 orchestrator 接受请求后立即调用。 */
export async function createTurnRecord(input: CreateTurnInput): Promise<TurnRecord> {
  const repo = getSessionRepository();
  await getOrCreateSession(input.sessionId);
  return repo.createTurn(input);
}

/** 标记 turn 完成并写入用量、模型和结束时间。 */
export async function completeTurnRecord(input: CompleteTurnRequest): Promise<void> {
  const repo = getSessionRepository();
  await repo.updateTurn({
    ...input,
    status: "completed",
    endedAt: input.endedAt ?? Date.now(),
  });
}

/** 更新 turn 状态，失败、取消、等待权限都通过这里记录。 */
export async function updateTurnStatus(
  requestId: string,
  status: TurnStatus,
  endedAt?: number,
): Promise<void> {
  const repo = getSessionRepository();
  await repo.updateTurn({
    requestId,
    status,
    endedAt,
  });
}

/** 获取单条 turn，给调试页和 retry 逻辑使用。 */
export async function getTurnById(requestId: string): Promise<TurnRecord | null> {
  const repo = getSessionRepository();
  return repo.getTurnById(requestId);
}

/** 分页列出某个 session 下的 turns。 */
export async function listSessionTurns(sessionId: string, options?: ListTurnsOptions): Promise<TurnPage> {
  const repo = getSessionRepository();
  return repo.listTurnsBySession(sessionId, options);
}
