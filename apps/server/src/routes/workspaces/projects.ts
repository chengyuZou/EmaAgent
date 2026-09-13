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
  folderPaths: z.array(z.string().trim().min(1)),
  primaryFolderPath: z.string().trim().min(1).optional(),
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
});

export const projectsRoute = (deps: ProjectsRouteDeps) =>
  new Hono()
    .post('/projects', jsonBody(createBody), async context => {
      const { name, folderPaths, primaryFolderPath } = context.req.valid('json');
      try {
        return context.json(
          deps.session.createProject(name, folderPaths, primaryFolderPath),
          201,
        );
      } catch (error) {
        return projectError(context, error);
      }
    })
    .patch('/projects/:id', jsonBody(renameBody), async context => {
      deps.session.renameProject(context.req.param('id'), context.req.valid('json').name);
      return context.json({ ok: true });
    })
    // 删除项目：成员 Session 由外键 SET NULL 掉到非项目区，cwd 保留。
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
    // 移除主文件夹仅影响项目以后新建 Session 的默认 cwd。
    .delete('/projects/:id/folders', jsonBody(folderBody), async context => {
      deps.session.removeProjectFolder(context.req.param('id'), context.req.valid('json').path);
      return context.json({ ok: true });
    })
    .put('/projects/:id/primary-folder', jsonBody(folderBody), async context => {
      deps.session.setProjectPrimaryFolder(context.req.param('id'), context.req.valid('json').path);
      return context.json({ ok: true });
    })
    // 拖入项目只改变归属，保留已有 Session 的 cwd。
    .post('/projects/:id/sessions', jsonBody(assignBody), async context => {
      const { sessionId } = context.req.valid('json');
      try {
        deps.session.assignSessionToProject(
          sessionId,
          context.req.param('id'),
        );
        return context.json({ ok: true });
      } catch (error) {
        return projectError(context, error);
      }
    })
    // 拖出项目：解除成员资格，cwd 保留原值。
    .delete('/projects/:id/sessions/:sessionId', context => {
      deps.session.removeSessionFromProject(context.req.param('sessionId'));
      return context.json({ ok: true });
    });

function projectError(context: Context, error: unknown) {
  if (error instanceof SessionOwnershipError) {
    return context.json({ error: 'session_ownership_violation', message: error.message }, 403);
  }
  const message = error instanceof Error ? error.message : String(error);
  if (message.startsWith('project_not_found:')) {
    return context.json({ error: 'project_not_found' }, 404);
  }
  if (message.startsWith('session_not_found:')) {
    return context.json({ error: 'session_not_found' }, 404);
  }
  if (message.includes('project_name_empty')) {
    return context.json({ error: 'project_name_empty' }, 400);
  }
  if (message.includes('project_primary_folder_missing')) {
    return context.json({ error: 'project_primary_folder_missing' }, 400);
  }
  if (message.includes('project_folder_duplicate')) {
    return context.json({ error: 'project_folder_duplicate' }, 400);
  }
  throw error;
}
