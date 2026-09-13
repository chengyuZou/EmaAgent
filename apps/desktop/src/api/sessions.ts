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
export type SessionSidebarData = RpcJson<RpcClient['api']['sessions']['$get']>;
/** 分组列表的会话条目（含 hasActiveTurn/lastTurnStatus/hasUnread 列表投影）。 */
export type SessionListItem = SessionSidebarData['recent'][number];
export type Project = SessionSidebarData['projects'][number];
export type SessionSearchResult = RpcJson<RpcClient['api']['sessions']['search']['$get']>;
export type SessionPatchInput = InferRequestType<RpcClient['api']['sessions'][':sessionId']['$put']>['json'];
export type SessionMessagePage = RpcJson<RpcClient['api']['sessions'][':sessionId']['messages']['$get']>;
/** 历史接口的单条消息（user 消息可能附带 attachments 投影）。 */
export type SessionHistoryMessage = SessionMessagePage['messages'][number];
export type TurnIndexPage = RpcJson<RpcClient['api']['sessions'][':sessionId']['turn-index']['$get']>;
export type SessionMessageWindow = RpcJson<RpcClient['api']['sessions'][':sessionId']['messages']['around']['$get']>;
export type SessionTurnMessages = RpcJson<RpcClient['api']['sessions'][':sessionId']['turns'][':turnId']['messages']['$get']>;
export type SessionAttachmentsResult = RpcJson<RpcClient['api']['sessions'][':sessionId']['attachments']['$get']>;
export type SessionPastedTextResult = RpcJson<RpcClient['api']['sessions'][':sessionId']['attachments']['pasted']['$post']>;
export type SessionImageUploadResult = RpcJson<RpcClient['api']['sessions'][':sessionId']['attachments']['images']['$post']>;
export type ForkResult = RpcJson<RpcClient['api']['sessions'][':sessionId']['fork']['$post']>;
export type RewindResult = RpcJson<RpcClient['api']['sessions'][':sessionId']['turns'][':turnId']['rewind']['$post']>;
export type SessionImportResult = RpcJson<RpcClient['api']['sessions']['import']['$post']>;

// ── API ──────────────────────────────────────────────────────────────────────

export const sessionsApi = {
  /** POST /api/sessions — 创建空 Session（body 全 optional，发 {} 即全默认）。 */
  create(input: SessionCreateInput = {}): Promise<Session> {
    return readRpcJson(rpcClient.api.sessions.$post({ json: input }));
  },

  /** GET /api/sessions — 分组列表（侧栏唯一路径）。 */
  listForSidebar(): Promise<SessionSidebarData> {
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

  /** GET /api/sessions/:sessionId — 单 Session 当前记录。 */
  get(id: string): Promise<Session> {
    return readRpcJson(rpcClient.api.sessions[':sessionId'].$get({ param: { sessionId: id } }));
  },

  /** PUT /api/sessions/:sessionId — 局部更新并返回最新记录。 */
  patch(id: string, patch: SessionPatchInput): Promise<Session> {
    return readRpcJson(
      rpcClient.api.sessions[':sessionId'].$put({ json: patch, param: { sessionId: id } }),
    );
  },

  /** GET /api/sessions/:sessionId/messages — Message 正文游标页。 */
  listMessages(
    id: string,
    opts?: { before?: string; limit?: number },
  ): Promise<SessionMessagePage> {
    return readRpcJson(rpcClient.api.sessions[':sessionId'].messages.$get({
      param: { sessionId: id },
      query: {
        ...(opts?.before ? { before: opts.before } : {}),
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

  /** GET /api/sessions/:sessionId/messages/around — Message 锚点有界历史窗口。 */
  listMessagesAround(
    id: string,
    opts: { anchorMessageId: string; before?: number; after?: number },
  ): Promise<SessionMessageWindow> {
    return readRpcJson(rpcClient.api.sessions[':sessionId'].messages.around.$get({
      param: { sessionId: id },
      query: {
        anchorMessageId: opts.anchorMessageId,
        ...(opts.before !== undefined ? { before: String(opts.before) } : {}),
        ...(opts.after !== undefined ? { after: String(opts.after) } : {}),
      },
    }));
  },

  /** GET /api/sessions/:sessionId/turns/:turnId/messages — Turn 终态持久收口。 */
  listTurnMessages(sessionId: string, turnId: string): Promise<SessionTurnMessages> {
    return readRpcJson(rpcClient.api.sessions[':sessionId'].turns[':turnId'].messages.$get({
      param: { sessionId, turnId },
    }));
  },

  /** GET /api/sessions/:sessionId/attachments — 当前会话的全部附件(两本账合并)。 */
  listAttachments(id: string): Promise<SessionAttachmentsResult> {
    return readRpcJson(
      rpcClient.api.sessions[':sessionId'].attachments.$get({ param: { sessionId: id } }),
    );
  },

  /** 粘贴大段文本:粘贴那一刻落盘入账,返回 chip 所需的 path/preview。 */
  createPastedText(id: string, content: string): Promise<SessionPastedTextResult> {
    return readRpcJson(rpcClient.api.sessions[':sessionId'].attachments.pasted.$post({
      param: { sessionId: id },
      json: { content },
    }));
  },

  /** 粘贴/拖入图片:剪贴板给 dataBase64,拖入文件给 sourcePath;name 是拖入时的原文件名。 */
  uploadImage(
    id: string,
    input: { dataBase64: string; name?: string } | { sourcePath: string; name?: string },
  ): Promise<SessionImageUploadResult> {
    return readRpcJson(rpcClient.api.sessions[':sessionId'].attachments.images.$post({
      param: { sessionId: id },
      json: input,
    }));
  },

  /** 附件内容是字节流，不进入 JSON RPC。按受管 path 读,thumb=1 取 256px 缩略图。 */
  readAttachmentContent(sessionId: string, attachmentPath: string, thumb = false): Promise<Response> {
    return serverClient.requestRaw(
      `/api/sessions/${encodeURIComponent(sessionId)}/attachments/content?path=${encodeURIComponent(attachmentPath)}${thumb ? '&thumb=1' : ''}`,
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

  /** DELETE /api/sessions/:sessionId（204）。 */
  delete(id: string): Promise<void> {
    return readRpcVoid(rpcClient.api.sessions[':sessionId'].$delete({ param: { sessionId: id } }));
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
