// 技能目录与正文：全量列表（含 enabled 投影）、单条详情、SKILL.md 正文与 user 技能删除。
import { join } from 'node:path';
import { Hono } from 'hono';
import type { SessionStore } from '@ema-agent/session';
import {
  builtinSkillsEnabledSetting,
  disabledProjectSourcesSetting,
  disabledSkillKeysSetting,
  isSkillEnabled,
  parseSkillKey,
  readSkillFileBounded,
  type SkillDescriptor,
  type SkillEnablement,
  type SkillRegistry,
  type SkillStore,
} from '@ema-agent/skills';
import type { SettingsStore } from '@ema-agent/settings';

export interface SkillListRouteDeps {
  readonly skills: Pick<SkillRegistry, 'list' | 'getByKey' | 'refreshCore'>;
  readonly skillStore: Pick<SkillStore, 'deleteUserSkill'>;
  readonly settings: Pick<SettingsStore, 'get'>;
  /** sessionId → 工作区：project 技能按 Session 工作区合成；不传 sessionId 只见 builtin+user。 */
  readonly sessions: Pick<SessionStore, 'getSession'>;
}

export function skillListRoute(deps: SkillListRouteDeps): Hono {
  const app = new Hono();
  const workspaceOf = (sessionId: string | undefined): string | undefined => {
    if (!sessionId) return undefined;
    return deps.sessions.getSession(sessionId).workspaceRoot ?? undefined;
  };

  app.get('/', async context => {
    const enablement = readEnablement(deps.settings);
    const entries = await deps.skills.list(workspaceOf(context.req.query('sessionId')));
    return context.json({ items: entries.map(entry => toWire(entry, enablement)) });
  });

  // key 含冒号与斜杠（project:<sourceId>:<relPath>），一律走 query 不走进路径段。
  app.get('/descriptor', async context => {
    const key = parseSkillKey(context.req.query('key') ?? '');
    if (!key) return context.json({ error: 'invalid_skill_key' }, 400);
    const entry = await deps.skills.getByKey(key, workspaceOf(context.req.query('sessionId')));
    if (!entry) return context.json({ error: 'skill_not_found' }, 404);
    return context.json(toWire(entry, readEnablement(deps.settings)));
  });

  app.get('/content', async context => {
    const key = parseSkillKey(context.req.query('key') ?? '');
    if (!key) return context.json({ error: 'invalid_skill_key' }, 400);
    const entry = await deps.skills.getByKey(key, workspaceOf(context.req.query('sessionId')));
    if (!entry) return context.json({ error: 'skill_not_found' }, 404);
    const content = await readSkillFileBounded(join(entry.rootPath, 'SKILL.md'));
    return context.json({ key: entry.key, content });
  });

  // 只有 user 技能可删：builtin 只读，project 跟随工作区文件。
  app.delete('/', async context => {
    const key = parseSkillKey(context.req.query('key') ?? '');
    if (!key) return context.json({ error: 'invalid_skill_key' }, 400);
    const entry = await deps.skills.getByKey(key, workspaceOf(context.req.query('sessionId')));
    if (!entry) return context.json({ error: 'skill_not_found' }, 404);
    if (entry.scope !== 'user') {
      return context.json({ error: 'skill_not_deletable', message: '只有用户技能可以删除' }, 400);
    }
    await deps.skillStore.deleteUserSkill(key);
    await deps.skills.refreshCore();
    return context.json({ ok: true });
  });

  return app;
}

/** 当前三开关值；enabled 判定规则由 skills 包单点拥有。 */
function readEnablement(settings: Pick<SettingsStore, 'get'>): SkillEnablement {
  return {
    disabledKeys: settings.get(disabledSkillKeysSetting),
    disabledProjectSources: settings.get(disabledProjectSourcesSetting).disabledSourceIds,
    builtinEnabled: settings.get(builtinSkillsEnabledSetting),
  };
}

/** wire 投影：rootPath 是本机部署细节，不下发。 */
function toWire(entry: SkillDescriptor, enablement: SkillEnablement) {
  const { rootPath: _rootPath, ...rest } = entry;
  return { ...rest, enabled: isSkillEnabled(entry, enablement) };
}
