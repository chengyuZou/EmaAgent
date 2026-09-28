// 管理已安装 Skill 目录与 enabled 投影; 启停走 skills 端点, 市场安装在独立窗口.
import { create } from 'zustand';
import type { AppEvent } from '@ema-agent/server/application/appEvents.js';
import {
  skillsApi,
  type SkillListItem,
} from '../api/skills.js';

// ── Store interface ───────────────────────────────────────────────────────────

export interface SkillStoreState {
  skills:   SkillListItem[];
  /** 是否已装载过（skills_changed 事件的自刷新门槛：没装载过的窗口不预取）。 */
  loaded:   boolean;
  loading:  boolean;
  error:    string | null;

  /** 装载全部已安装技能。幂等——已装载则跳过。 */
  load(): Promise<void>;
  /** 重读技能目录投影（不重扫文件）。 */
  refresh(): Promise<void>;
  /** 真实重扫 builtin+user 目录后重读（手放目录即时生效）。 */
  rescan(): Promise<void>;

  /** 逐技能启停: 写 skills.enabled 后用返回投影原位更新. */
  setEnabled(path: string, enabled: boolean): Promise<void>;

  /** 按来源调用 builtin/user 删除入口, project 不由应用删除. */
  remove(skill: SkillListItem): Promise<void>;
}

// ── Store ─────────────────────────────────────────────────────────────────────

export const useSkillStore = create<SkillStoreState>((set, get) => ({
  skills:  [],
  loaded:  false,
  loading: false,
  error:   null,

  async load() {
    if (get().loaded) return;
    return get().refresh();
  },

  async refresh() {
    set({ loading: true, error: null });
    try {
      const { items } = await skillsApi.list();
      set({ skills: [...items], loaded: true, loading: false });
    } catch (err: unknown) {
      set({
        error: err instanceof Error ? err.message : '加载技能列表失败',
        loading: false,
      });
    }
  },

  async rescan() {
    await skillsApi.rescan();
    await get().refresh();
  },

  async setEnabled(path, enabled) {
    try {
      const updated = await skillsApi.setEnabled(path, enabled);
      set((s) => ({
        skills: s.skills.map(sk => sk.path === path ? { ...sk, enabled: updated.enabled } : sk),
      }));
    } catch (err: unknown) {
      set({ error: err instanceof Error ? err.message : '更新技能开关失败' });
      throw err;
    }
  },

  async remove(skill) {
    try {
      if (skill.scope === 'builtin') {
        await skillsApi.removeBuiltin(skill.path);
      } else if (skill.scope === 'user') {
        await skillsApi.removeUser(skill.path);
      } else {
        throw new Error('项目技能不由应用删除');
      }
      set(s => ({ skills: s.skills.filter(sk => sk.path !== skill.path) }));
    } catch (err: unknown) {
      set({ error: err instanceof Error ? err.message : '卸载技能失败' });
      throw err;
    }
  },
}));

export function handleSkillSystemEvent(event: AppEvent): void {
  if (event.type === 'skills_changed' && useSkillStore.getState().loaded) {
    void useSkillStore.getState().refresh().catch(() => {});
  }
}
