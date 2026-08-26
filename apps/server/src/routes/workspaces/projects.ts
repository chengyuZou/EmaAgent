// 项目管理：项目 CRUD、置顶、文件夹清单与 Session 成员拖拽；列表投影由 sessions 域提供。
import { Hono, type Context } from 'hono';
import { z } from 'zod';
import { SessionOwnershipError, type SessionStore } from '@ema-agent/session';
import { jsonBody } from '../validate.js';

export interface ProjectsRouteDeps {
  readonly session: Pick<
    SessionStore,
    | 'createProject'
    | 'renameProject'
    | 'deleteProject'
    | 'pinProject'
    | 'addProjectFolder'
    | 'removeProjectFolder'
    | 'setProjectPrimaryFolder'
    | 'assignSessionToProject'
    | 'removeSessionFromProject'
  >;
}

const createBody = z.object({
  name: z.string().min(1).max(100),
  firstFolderPath: z.string().min(1).optional(),
});

const renameBody = z.object({
  name: z.string().min(1).max(100),
});

const pinBody = z.object({
  pinned: z.boolean(),
});

const folderBody = z.object({
  path: z.string().min(1),
});

const assignBody = z.object({
  sessionId: z.string().min(1),
  /** true 且原工作区不在清单时，先把它加为非主文件夹（弹窗确认加入的那条路径）。 */
  includeCurrentWorkspace: z.boolean().optional(),
});

export const projectsRoute = (deps: ProjectsRouteDeps) =>
  new Hono()
    .post('/projects', jsonBody(createBody), async context => {
      const { name, firstFolderPath } = context.req.valid('json');
      try {
        return context.json(deps.session.createProject(name, firstFolderPath), 201);
      } catch (error) {
        return projectError(context, error);
      }
    })
    .patch('/projects/:id', jsonBody(renameBody), async context => {
      deps.session.renameProject(context.req.param('id'), context.req.valid('json').name);
      return context.json({ ok: true });
    })
    // 删除项目：成员 Session 由外键 SET NULL 掉到非项目区，工作区保留。
    .delete('/projects/:id', context => {
      deps.session.deleteProject(context.req.param('id'));
      return context.json({ ok: true });
    })
    .post('/projects/:id/pin', jsonBody(pinBody), async context => {
      deps.session.pinProject(context.req.param('id'), context.req.valid('json').pinned);
      return context.json({ ok: true });
    })
    .post('/projects/:id/folders', jsonBody(folderBody), async context => {
      deps.session.addProjectFolder(context.req.param('id'), context.req.valid('json').path);
      return context.json({ ok: true });
    })
    // 移除主文件夹会触发继位并级联改写成员 workspace_root（SessionStore 内事务）。
    .delete('/projects/:id/folders', jsonBody(folderBody), async context => {
      deps.session.removeProjectFolder(context.req.param('id'), context.req.valid('json').path);
      return context.json({ ok: true });
    })
    .put('/projects/:id/primary-folder', jsonBody(folderBody), async context => {
      deps.session.setProjectPrimaryFolder(context.req.param('id'), context.req.valid('json').path);
      return context.json({ ok: true });
    })
    // 拖入项目：workspace_root 立即改写为项目主工作区并锁定。
    .post('/projects/:id/sessions', jsonBody(assignBody), async context => {
      const { sessionId, includeCurrentWorkspace } = context.req.valid('json');
      try {
        deps.session.assignSessionToProject(
          sessionId,
          context.req.param('id'),
          includeCurrentWorkspace ?? false,
        );
        return context.json({ ok: true });
      } catch (error) {
        return projectError(context, error);
      }
    })
    // 拖出项目：解除成员资格，workspace_root 保留原值恢复自由。
    .delete('/projects/:id/sessions/:sessionId', context => {
      deps.session.removeSessionFromProject(context.req.param('sessionId'));
      return context.json({ ok: true });
    });

function projectError(context: Context, error: unknown) {
  if (error instanceof SessionOwnershipError) {
    return context.json({ error: 'session_ownership_violation', message: error.message }, 403);
  }
  const message = error instanceof Error ? error.message : String(error);
  if (message.includes('project_has_no_folder')) {
    return context.json({ error: 'project_has_no_folder', message }, 400);
  }
  if (message.includes('project_name_empty')) {
    return context.json({ error: 'project_name_empty' }, 400);
  }
  throw error;
}
