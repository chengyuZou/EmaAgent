// 组合 Session 的集合、历史、附件与动作子资源，同时保持既有 HTTP 路径不变。
import { Hono } from 'hono';
import type { AttachmentStorePort, FileAccessFacade } from '@ema-agent/attachment';
import type {
  SessionLifecycle,
  SessionStore,
  SessionTitleGenerator,
} from '@ema-agent/session';
import { sessionCollectionRoute } from './sessionCollection.js';
import { sessionHistoryRoute } from './sessionHistory.js';
import { sessionAttachmentsRoute } from './sessionAttachments.js';
import { sessionActionsRoute } from './sessionActions.js';
import { sessionTitleRoute } from './sessionTitle.js';
import { sessionGitRoute } from './sessionGit.js';

export function sessionsRoute(
  session: SessionStore,
  lifecycle: SessionLifecycle,
  titleGenerator: SessionTitleGenerator,
  attachments: AttachmentStorePort,
  fileAccess: Pick<FileAccessFacade, 'issue'>,
): Hono {
  const app = new Hono();
  app.route('/', sessionCollectionRoute(session));
  app.route('/', sessionHistoryRoute(session, attachments, fileAccess));
  app.route('/', sessionAttachmentsRoute(session, attachments, fileAccess));
  app.route('/', sessionActionsRoute(session, lifecycle));
  app.route('/', sessionTitleRoute(titleGenerator));
  app.route('/', sessionGitRoute(session));
  return app;
}
