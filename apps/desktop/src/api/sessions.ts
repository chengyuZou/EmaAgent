// Sessions API：/api/sessions 挂载面——集合/动作/历史/附件 + backup 支路（export/import）
// 与 compact 命令。export 流式下载与 import multipart 走 requestRaw 逃生口，不进 hc 账本。
import type { InferRequestType } from 'hono/client';
import {
  rpcClient,
  readRpcJson,
  readRpcVoid,
  serverClient,
  type RpcClient,
  type RpcJson,
} from './client.js';

// ── 类型（全部从路由契约推导） ────────────────────────────────────────────────

export type SessionCreateInput = InferRequestType<RpcClient['api']['sessions']['$post']>['json'];
export type Session = RpcJson<RpcClient['api']['sessions']['$post']>;
export type SessionsGrouped = RpcJson<RpcClient['api']['sessions']['$get']>;
export type SessionSearchResult = RpcJson<RpcClient['api']['sessions']['search']['$get']>;
export type SessionPatchInput = InferRequestType<RpcClient['api']['sessions'][':sessionId']['$put']>['json'];
export type SessionMessagesResult = RpcJson<RpcClient['api']['sessions'][':sessionId']['messages']['$get']>;
export type TurnIndexPage = RpcJson<RpcClient['api']['sessions'][':sessionId']['turn-index']['$get']>;
export type SessionMessageWindow = RpcJson<RpcClient['api']['sessions'][':sessionId']['messages']['window']['$get']>;
export type SessionAttachmentsResult = RpcJson<RpcClient['api']['sessions'][':sessionId']['attachments']['$get']>;
export type ForkResult = RpcJson<RpcClient['api']['sessions'][':sessionId']['fork']['$post']>;
export type RewindResult = RpcJson<RpcClient['api']['sessions'][':sessionId']['turns'][':turnId']['rewind']['$post']>;
export type CompactResult = RpcJson<RpcClient['api']['sessions'][':sessionId']['compact']['$post']>;
export type SessionImportResult = RpcJson<RpcClient['api']['sessions']['import']['$post']>;

// ── API ──────────────────────────────────────────────────────────────────────

export const sessionsApi = {
  /** POST /api/sessions — 创建空 Session（body 全 optional，发 {} 即全默认）。 */
  create(opts: SessionCreateInput = {}): Promise<Session> {
    return readRpcJson(rpcClient.api.sessions.$post({ json: opts }));
  },

  /** GET /api/sessions — 分组列表（侧栏唯一路径）。 */
  listGrouped(): Promise<SessionsGrouped> {
    return readRpcJson(rpcClient.api.sessions.$get());
  },

  /** GET /api/sessions/search — 搜索标题与消息正文。 */
  search(opts: { q: string; limit?: number }): Promise<SessionSearchResult> {
    return readRpcJson(rpcClient.api.sessions.search.$get({
      query: {
        q: opts.q,
        ...(opts.limit !== undefined ? { limit: String(opts.limit) } : {}),
      },
    }));
  },

  /** GET /api/sessions/:sessionId — 单 Session 快照。 */
  get(id: string): Promise<Session> {
    return readRpcJson(rpcClient.api.sessions[':sessionId'].$get({ param: { sessionId: id } }));
  },

  /** PUT /api/sessions/:sessionId — 局部更新并返回最新快照。 */
  patch(id: string, patch: SessionPatchInput): Promise<Session> {
    return readRpcJson(
      rpcClient.api.sessions[':sessionId'].$put({ json: patch, param: { sessionId: id } }),
    );
  },

  /** GET /api/sessions/:sessionId/messages — 消息与 Turn 一次取回。 */
  listMessages(
    id: string,
    opts?: { before?: number; limit?: number },
  ): Promise<SessionMessagesResult> {
    return readRpcJson(rpcClient.api.sessions[':sessionId'].messages.$get({
      param: { sessionId: id },
      query: {
        ...(opts?.before !== undefined ? { before: String(opts.before) } : {}),
        ...(opts?.limit !== undefined ? { limit: String(opts.limit) } : {}),
      },
    }));
  },

  /** GET /api/sessions/:sessionId/turn-index — 轻量 Turn 导航索引。 */
  listTurnIndex(
    id: string,
    opts?: { cursor?: string; limit?: number },
  ): Promise<TurnIndexPage> {
    return readRpcJson(rpcClient.api.sessions[':sessionId']['turn-index'].$get({
      param: { sessionId: id },
      query: {
        ...(opts?.cursor ? { cursor: opts.cursor } : {}),
        ...(opts?.limit !== undefined ? { limit: String(opts.limit) } : {}),
      },
    }));
  },

  /** GET /api/sessions/:sessionId/messages/window — 锚点有界历史窗口。 */
  listMessageWindow(
    id: string,
    opts: { anchorTurnId: string; beforeTurns?: number; afterTurns?: number },
  ): Promise<SessionMessageWindow> {
    return readRpcJson(rpcClient.api.sessions[':sessionId'].messages.window.$get({
      param: { sessionId: id },
      query: {
        anchorTurnId: opts.anchorTurnId,
        ...(opts.beforeTurns !== undefined ? { beforeTurns: String(opts.beforeTurns) } : {}),
        ...(opts.afterTurns !== undefined ? { afterTurns: String(opts.afterTurns) } : {}),
      },
    }));
  },

  /** GET /api/sessions/:sessionId/attachments — 当前会话的全部附件。 */
  listAttachments(id: string): Promise<SessionAttachmentsResult> {
    return readRpcJson(
      rpcClient.api.sessions[':sessionId'].attachments.$get({ param: { sessionId: id } }),
    );
  },

  /** POST /api/sessions/:sessionId/fork — 复制完整或到指定 Turn（fork 到最新发 {}）。 */
  fork(id: string, untilTurnId?: string): Promise<ForkResult> {
    return readRpcJson(rpcClient.api.sessions[':sessionId'].fork.$post({
      json: untilTurnId ? { untilTurnId } : {},
      param: { sessionId: id },
    }));
  },

  /** POST /api/sessions/:sessionId/turns/:turnId/rewind — 回滚最后一轮。 */
  rewindLastTurn(id: string, turnId: string): Promise<RewindResult> {
    return readRpcJson(
      rpcClient.api.sessions[':sessionId'].turns[':turnId'].rewind.$post({
        param: { sessionId: id, turnId },
      }),
    );
  },

  /** POST /api/sessions/:sessionId/viewed — 标记已读（204）。 */
  markViewed(id: string): Promise<void> {
    return readRpcVoid(rpcClient.api.sessions[':sessionId'].viewed.$post({ param: { sessionId: id } }));
  },

  /** POST /api/sessions/:sessionId/archive（204）。 */
  archive(id: string): Promise<void> {
    return readRpcVoid(rpcClient.api.sessions[':sessionId'].archive.$post({ param: { sessionId: id } }));
  },

  /** POST /api/sessions/:sessionId/unarchive（204）。 */
  unarchive(id: string): Promise<void> {
    return readRpcVoid(rpcClient.api.sessions[':sessionId'].unarchive.$post({ param: { sessionId: id } }));
  },

  /** POST /api/sessions/:sessionId/abort — Session 级停止（204；无活跃执行 409）。 */
  abort(id: string): Promise<void> {
    return readRpcVoid(rpcClient.api.sessions[':sessionId'].abort.$post({ param: { sessionId: id } }));
  },

  /** DELETE /api/sessions/:sessionId（204）。 */
  delete(id: string): Promise<void> {
    return readRpcVoid(rpcClient.api.sessions[':sessionId'].$delete({ param: { sessionId: id } }));
  },

  /** POST /api/sessions/:sessionId/compact — 手动压缩历史（挂起式响应）。 */
  compact(sessionId: string): Promise<CompactResult> {
    return readRpcJson(rpcClient.api.sessions[':sessionId'].compact.$post({ param: { sessionId } }));
  },

  /** POST /api/sessions/:id/export — 流式下载单 Session ZIP（字节流走 requestRaw 逃生口）。 */
  exportSession(id: string, signal?: AbortSignal): Promise<Response> {
    return serverClient.requestRaw(`/api/sessions/${id}/export`, {
      method: 'POST',
      signal,
    });
  },

  /** POST /api/sessions/import — multipart 上传 ZIP（file 字段=备份本体）；requestRaw 已归一错误。 */
  async importSession(file: File): Promise<SessionImportResult> {
    const form = new FormData();
    form.append('file', file);
    const res = await serverClient.requestRaw('/api/sessions/import', {
      method: 'POST',
      body: form,
    });
    return res.json();
  },
};
