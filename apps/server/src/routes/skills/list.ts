// 技能目录与正文：全量列表（含 enabled 投影）、单条详情、SKILL.md 正文、
// 目录文件清单与文件预览、逐技能启停（skill_enablement）、真实重扫与 user 技能删除。
import { readFile, readdir, stat } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { Hono } from 'hono';
import { z } from 'zod';
import type { SessionStore } from '@ema-agent/session';
import {
  disabledProjectSourcesSetting,
  isSkillEnabled,
  resolveFileInside,
  SKILL_FILE_PREVIEW_MAX_BYTES,
  SKILL_FILES_MAX,
  PROJECT_ECOSYSTEMS,
  type SkillDescriptor,
  type SkillEnablement,
  type SkillRegistry,
  type SkillStore,
} from '@ema-agent/skills';
import type { SkillEnablementRepo } from '@ema-agent/storage';
import type { SettingsStore } from '@ema-agent/settings';
import { jsonBody, queryValidator } from '../validate.js';
import type { AppEvent } from '../../sse/eventHub.js';

export interface SkillListRouteDeps {
  readonly skills: Pick<SkillRegistry, 'list' | 'getByPath' | 'refreshCore' | 'refreshWorkspace'>;
  readonly skillStore: Pick<SkillStore, 'deleteUserSkill'>;
  /** builtin/user 逐技能启停事实（skill_enablement 表）。 */
  readonly skillEnablement: Pick<SkillEnablementRepo, 'listDisabledPaths' | 'setEnabled'>;
  readonly settings: Pick<SettingsStore, 'get'>;
  /** sessionId → 工作区：project 技能按 Session 工作区合成；不传 sessionId 只见 builtin+user。 */
  readonly sessions: Pick<SessionStore, 'getSession'>;
  /** 启停/删除/重扫后广播 skills_changed,让其他窗口重读。 */
  readonly emitApp: (event: AppEvent) => void;
}

const listQuery = z.object({
  sessionId: z.string().min(1).optional(),
});

/** 绝对路径放在 query 中,不进入 URL 路径段。 */
const skillQuery = z.object({
  skillPath: z.string().min(1),
  sessionId: z.string().min(1).optional(),
});

const skillFileQuery = skillQuery.extend({
  path: z.string().min(1).max(240),
});

const enabledBody = z.object({
  path: z.string().min(1),
  enabled: z.boolean(),
});

export const skillListRoute = (deps: SkillListRouteDeps) => {
  const workspaceOf = (sessionId: string | undefined): string | undefined => {
    if (!sessionId) return undefined;
    return deps.sessions.getSession(sessionId).workspaceRoot ?? undefined;
  };
  const readEnablement = (): SkillEnablement => ({
    disabledPaths: deps.skillEnablement.listDisabledPaths(),
    disabledProjectSources: deps.settings.get(disabledProjectSourcesSetting).disabledSourceIds,
  });

  return new Hono()
    .get('/sources', context => context.json({ items: PROJECT_ECOSYSTEMS }))
    .get('/', queryValidator(listQuery), async context => {
      const enablement = readEnablement();
      const entries = await deps.skills.list(workspaceOf(context.req.valid('query').sessionId));
      return context.json({ items: entries.map(entry => toWire(entry, enablement)) });
    })
    .get('/descriptor', queryValidator(skillQuery), async context => {
      const { skillPath, sessionId } = context.req.valid('query');
      const entry = await deps.skills.getByPath(skillPath, workspaceOf(sessionId));
      if (!entry) return context.json({ error: 'skill_not_found' }, 404);
      return context.json(toWire(entry, readEnablement()));
    })
    .get('/content', queryValidator(skillQuery), async context => {
      const { skillPath, sessionId } = context.req.valid('query');
      const entry = await deps.skills.getByPath(skillPath, workspaceOf(sessionId));
      if (!entry) return context.json({ error: 'skill_not_found' }, 404);
      const content = await readFile(entry.path, 'utf8');
      return context.json({ path: entry.path, content });
    })
    // 技能目录的文件清单与预览:dotfiles 不进(藏住 .ema-market.json 这类内部文件)。
    .get('/files', queryValidator(skillQuery), async context => {
      const { skillPath, sessionId } = context.req.valid('query');
      const entry = await deps.skills.getByPath(skillPath, workspaceOf(sessionId));
      if (!entry) return context.json({ error: 'skill_not_found' }, 404);
      return context.json({ items: await listSkillFiles(dirname(entry.path)) });
    })
    .get('/file', queryValidator(skillFileQuery), async context => {
      const { skillPath, path: filePath } = context.req.valid('query');
      const entry = await deps.skills.getByPath(skillPath);
      if (!entry) return context.json({ error: 'skill_not_found' }, 404);
      let target: string;
      try {
        target = await resolveFileInside(dirname(entry.path), filePath);
      } catch {
        return context.json({ error: 'invalid_file_path' }, 400);
      }
      const info = await stat(target);
      const truncated = info.size > SKILL_FILE_PREVIEW_MAX_BYTES;
      const raw = await readFile(target, 'utf8');
      const content = truncated
        ? Buffer.from(raw, 'utf8').subarray(0, SKILL_FILE_PREVIEW_MAX_BYTES).toString('utf8')
        : raw;
      return context.json({ path: filePath, content, size: info.size, truncated });
    })
    // 逐技能启停只覆盖 builtin/user；project 技能由来源级开关控制（disabledProjectSources）。
    .put('/enabled', jsonBody(enabledBody), async context => {
      const { path, enabled } = context.req.valid('json');
      const entry = await deps.skills.getByPath(path);
      if (entry?.scope === 'project') {
        return context.json({ error: 'project_skill_uses_source_toggle', message: '项目技能由来源级开关控制' }, 400);
      }
      if (!entry) return context.json({ error: 'skill_not_found' }, 404);
      deps.skillEnablement.setEnabled(path, enabled);
      deps.emitApp({ type: 'skills_changed' });
      return context.json(toWire(entry, readEnablement()));
    })
    // 真实重扫 builtin+user 目录：手放目录的技能在此之后可见。
    .post('/rescan', queryValidator(listQuery), async context => {
      await deps.skills.refreshCore();
      const workspaceRoot = workspaceOf(context.req.valid('query').sessionId);
      if (workspaceRoot) await deps.skills.refreshWorkspace(workspaceRoot);
      deps.emitApp({ type: 'skills_changed' });
      return context.json({ ok: true });
    })
    // 只有 user 技能可删：builtin 只读，project 跟随工作区文件。
    .delete('/', queryValidator(skillQuery), async context => {
      const { skillPath, sessionId } = context.req.valid('query');
      const entry = await deps.skills.getByPath(skillPath, workspaceOf(sessionId));
      if (!entry) return context.json({ error: 'skill_not_found' }, 404);
      if (entry.scope !== 'user') {
        return context.json({ error: 'skill_not_deletable', message: '只有用户技能可以删除' }, 400);
      }
      await deps.skillStore.deleteUserSkill(skillPath);
      await deps.skills.refreshCore();
      deps.emitApp({ type: 'skills_changed' });
      return context.json({ ok: true });
    });
}

function toWire(entry: SkillDescriptor, enablement: SkillEnablement) {
  return { ...entry, enabled: isSkillEnabled(entry, enablement) };
}

/** 递归列技能目录文件(POSIX 相对路径 + 大小),dotfiles 不进,深度 4 与总数上限防失控。 */
async function listSkillFiles(root: string): Promise<{ path: string; size: number }[]> {
  const found: { path: string; size: number }[] = [];
  async function walk(dir: string, rel: string, depth: number): Promise<void> {
    if (depth > 4 || found.length >= SKILL_FILES_MAX) return;
    let children;
    try {
      children = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const child of children) {
      if (found.length >= SKILL_FILES_MAX) return;
      if (child.name.startsWith('.')) continue;
      if (child.isSymbolicLink()) continue;
      const childRel = rel ? `${rel}/${child.name}` : child.name;
      if (child.isDirectory()) {
        await walk(join(dir, child.name), childRel, depth + 1);
      } else if (child.isFile()) {
        found.push({ path: childRel, size: (await stat(join(dir, child.name))).size });
      }
    }
  }
  await walk(root, '', 1);
  return found;
}
