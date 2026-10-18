import type { InferRequestType } from 'hono/client';
import {
  rpcClient,
  readRpcJson,
  readRpcVoid,
  serverClient,
  type RpcClient,
  type RpcJson,
} from './client.js';


export type SessionCreateInput = InferRequestType<RpcClient['api']['sessions']['$post']>['json'];
export type Session = RpcJson<RpcClient['api']['sessions']['$post']>;
export type SessionSidebarData = RpcJson<RpcClient['api']['sessions']['$get']>;
export type ArchivedSession = RpcJson<RpcClient['api']['sessions']['archived']['$get']>[number];
export type ArchivedSessionsDeletionResult = RpcJson<RpcClient['api']['sessions']['archived']['$delete']>;
/** 分组列表的会话条目(含 hasActiveTurn/lastTurnStatus/hasUnread 列表投影). */
export type SessionListItem = SessionSidebarData['recent'][number];
export type Project = SessionSidebarData['projects'][number];
export type SessionSearchResult = RpcJson<RpcClient['api']['sessions']['search']['$get']>;
export type SessionPatchInput = InferRequestType<RpcClient['api']['sessions'][':sessionId']['$put']>['json'];
export type SessionMessagePage = RpcJson<RpcClient['api']['sessions'][':sessionId']['messages']['$get']>;
export type TurnIndexPage = RpcJson<RpcClient['api']['sessions'][':sessionId']['turn-index']['$get']>;
export type SessionMessageWindow = RpcJson<RpcClient['api']['sessions'][':sessionId']['messages']['around']['$get']>;
export type SessionTurnMessages = RpcJson<RpcClient['api']['sessions'][':sessionId']['turns'][':turnId']['messages']['$get']>;
export type SessionContextEstimate = RpcJson<RpcClient['api']['sessions'][':sessionId']['context-estimate']['$get']>;
export type SessionAttachmentsResult = RpcJson<RpcClient['api']['sessions'][':sessionId']['attachments']['$get']>;
export type SessionPastedTextResult = RpcJson<RpcClient['api']['sessions'][':sessionId']['attachments']['pasted']['$post']>;
export type SessionImageUploadResult = RpcJson<RpcClient['api']['sessions'][':sessionId']['attachments']['images']['$post']>;
export type ForkResult = RpcJson<RpcClient['api']['sessions'][':sessionId']['fork']['$post']>;
export type SessionImportResult = RpcJson<RpcClient['api']['sessions']['import']['$post']>;
export type SessionExportResult = RpcJson<RpcClient['api']['sessions'][':sessionId']['export']['$post']>;
export type SessionSummaries = RpcJson<RpcClient['api']['sessions']['summaries']['$get']>;
export type SessionSummary = SessionSummaries['sessions'][number];
export type RawMessagesPage = RpcJson<RpcClient['api']['sessions'][':sessionId']['raw-messages']['$get']>;
export type RawMessageHeader = RawMessagesPage['messages'][number];
export type SessionAudioPage = RpcJson<RpcClient['api']['sessions'][':sessionId']['audio']['$get']>;


export const sessionsApi = {
  listSummaries(signal?: AbortSignal): Promise<SessionSummaries> {
    return readRpcJson(rpcClient.api.sessions.summaries.$get({}, { init: { signal } }));
  },

  /** 只读取目录行头; turnId 指定时只列出这一轮, 不读取整轮 blocksJson. */
  listRawMessages(sessionId: string, input: {
    before?: NonNullable<RawMessagesPage['nextCursor']>;
    order?: 'asc' | 'desc';
    limit?: number;
    turnId?: string;
  }, signal?: AbortSignal): Promise<RawMessagesPage> {
    return readRpcJson(rpcClient.api.sessions[':sessionId']['raw-messages'].$get({
      param: { sessionId },
      query: {
        beforeCreatedAt: input.before ? String(input.before.createdAt) : undefined,
        beforeId: input.before?.id,
        order: input.order,
        limit: input.limit === undefined ? undefined : String(input.limit),
        turnId: input.turnId,
      },
    }, { init: { signal } }));
  },

  getRawMessage(sessionId: string, messageId: string, signal?: AbortSignal) {
    return readRpcJson(rpcClient.api.sessions[':sessionId']['raw-messages'][':messageId'].$get(
      { param: { sessionId, messageId } },
      { init: { signal } },
    ));
  },

  listAudio(sessionId: string, before?: NonNullable<SessionAudioPage['nextCursor']>, signal?: AbortSignal) {
    return readRpcJson(rpcClient.api.sessions[':sessionId'].audio.$get({
      param: { sessionId },
      query: {
        beforeCreatedAt: before ? String(before.createdAt) : undefined,
        beforeId: before?.id,
        limit: '50',
      },
    }, { init: { signal } }));
  },

  /** 不传字段时使用 Server 的新会话默认设置. */
  create(input: SessionCreateInput = {}): Promise<Session> {
    return readRpcJson(rpcClient.api.sessions.$post({ json: input }));
  },

  /** GET /api/sessions  -  分组列表(侧栏唯一路径). */
  listForSidebar(): Promise<SessionSidebarData> {
    return readRpcJson(rpcClient.api.sessions.$get());
  },

  listArchived(): Promise<ArchivedSession[]> {
    return readRpcJson(rpcClient.api.sessions.archived.$get());
  },

  /** GET /api/sessions/search  -  搜索标题与消息正文. */
  search(opts: { q: string; limit?: number }): Promise<SessionSearchResult> {
    return readRpcJson(rpcClient.api.sessions.search.$get({
      query: {
        q: opts.q,
        ...(opts.limit !== undefined ? { limit: String(opts.limit) } : {}),
      },
    }));
  },

  /** GET /api/sessions/:sessionId  -  单 Session 当前记录. */
  get(id: string, signal?: AbortSignal): Promise<Session> {
    return readRpcJson(rpcClient.api.sessions[':sessionId'].$get(
      { param: { sessionId: id } },
      { init: { signal } },
    ));
  },

  /** 当前 Prompt, 工具定义和有效历史的本地估算, 不发起模型请求. */
  estimateContext(id: string, signal?: AbortSignal): Promise<SessionContextEstimate> {
    return readRpcJson(rpcClient.api.sessions[':sessionId']['context-estimate'].$get({
      param: { sessionId: id },
    }, { init: { signal } }));
  },

  /** PUT /api/sessions/:sessionId  -  局部更新并返回最新记录. */
  patch(id: string, patch: SessionPatchInput): Promise<Session> {
    return readRpcJson(
      rpcClient.api.sessions[':sessionId'].$put({ json: patch, param: { sessionId: id } }),
    );
  },

  /** GET /api/sessions/:sessionId/messages  -  Message 正文游标页. */
  listMessages(
    id: string,
    opts?: { before?: string; after?: string; limit?: number },
  ): Promise<SessionMessagePage> {
    return readRpcJson(rpcClient.api.sessions[':sessionId'].messages.$get({
      param: { sessionId: id },
      query: {
        ...(opts?.before ? { before: opts.before } : {}),
        ...(opts?.after ? { after: opts.after } : {}),
        ...(opts?.limit !== undefined ? { limit: String(opts.limit) } : {}),
      },
    }));
  },

  /** GET /api/sessions/:sessionId/turn-index  -  轻量 Turn 导航索引. */
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

  /** 只读取锚点附近的消息, 用于跳转到尚未加载的历史位置. */
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

  /** Turn 结束后读取已保存的消息, 替换界面上的流式内容. */
  listTurnMessages(sessionId: string, turnId: string): Promise<SessionTurnMessages> {
    return readRpcJson(rpcClient.api.sessions[':sessionId'].turns[':turnId'].messages.$get({
      param: { sessionId, turnId },
    }));
  },

  /** 合并 Session 管理的附件与消息中引用的本机文件. */
  listAttachments(id: string): Promise<SessionAttachmentsResult> {
    return readRpcJson(
      rpcClient.api.sessions[':sessionId'].attachments.$get({ param: { sessionId: id } }),
    );
  },

  /** 把文本保存为附件并返回 path/preview, 供发送后的附件胶囊使用. */
  createPastedText(id: string, content: string): Promise<SessionPastedTextResult> {
    return readRpcJson(rpcClient.api.sessions[':sessionId'].attachments.pasted.$post({
      param: { sessionId: id },
      json: { content },
    }));
  },

  /** 剪贴板图片传 dataBase64, 本机图片传 sourcePath; name 保留原文件名. */
  uploadImage(
    id: string,
    input: { dataBase64: string; name?: string } | { sourcePath: string; name?: string },
  ): Promise<SessionImageUploadResult> {
    return readRpcJson(rpcClient.api.sessions[':sessionId'].attachments.images.$post({
      param: { sessionId: id },
      json: input,
    }));
  },

  /** 读取附件字节, thumb=true 时读取 256px 缩略图. */
  readAttachmentContent(sessionId: string, attachmentPath: string, thumb = false): Promise<Response> {
    return serverClient.requestRaw(
      `/api/sessions/${encodeURIComponent(sessionId)}/attachments/content?path=${encodeURIComponent(attachmentPath)}${thumb ? '&thumb=1' : ''}`,
    );
  },

  /** 未指定 untilTurnId 时复制到最新 Turn. */
  fork(id: string, untilTurnId?: string): Promise<ForkResult> {
    return readRpcJson(rpcClient.api.sessions[':sessionId'].fork.$post({
      json: untilTurnId ? { untilTurnId } : {},
      param: { sessionId: id },
    }));
  },

  /** POST /api/sessions/:sessionId/viewed  -  标记已读(204). */
  markViewed(id: string): Promise<void> {
    return readRpcVoid(rpcClient.api.sessions[':sessionId'].viewed.$post({ param: { sessionId: id } }));
  },

  archive(id: string): Promise<void> {
    return readRpcVoid(rpcClient.api.sessions[':sessionId'].archive.$post({
      param: { sessionId: id },
    }));
  },

  /** POST /api/sessions/:sessionId/unarchive(204). */
  unarchive(id: string): Promise<void> {
    return readRpcVoid(rpcClient.api.sessions[':sessionId'].unarchive.$post({ param: { sessionId: id } }));
  },

  delete(id: string): Promise<void> {
    return readRpcVoid(rpcClient.api.sessions[':sessionId'].$delete({
      param: { sessionId: id },
    }));
  },

  deleteArchived(): Promise<ArchivedSessionsDeletionResult> {
    return readRpcJson(rpcClient.api.sessions.archived.$delete());
  },

  /** 后端写完指定 ZIP 后返回结果, 前端不再读取 ZIP 字节. */
  exportSession(sessionId: string, destinationPath: string, signal?: AbortSignal): Promise<SessionExportResult> {
    return readRpcJson(rpcClient.api.sessions[':sessionId'].export.$post({
      param: { sessionId },
      json: { destinationPath },
    }, { init: { signal } }));
  },

  /** filePath 来自本机文件选择器, ZIP 由后端从磁盘读取. */
  importSession(filePath: string, signal?: AbortSignal): Promise<SessionImportResult> {
    return readRpcJson(rpcClient.api.sessions.import.$post({
      json: { filePath },
    }, { init: { signal } }));
  },
};
