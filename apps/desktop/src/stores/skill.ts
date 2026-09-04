// 管理已安装 Skill 目录（含 enabled 投影）与启停开关。
// 启停走 skills 业务端点（skill_enablement 表）；市场浏览与安装在独立市场窗口。
import { create } from 'zustand';
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

  /** 逐技能启停：写 skill_enablement 后用返回的投影原位更新。 */
  setEnabled(path: string, enabled: boolean): Promise<void>;

  /** 卸载一个 user Skill（builtin 只读、project 跟随工作区，服务端会拒绝）。 */
  remove(path: string): Promise<void>;
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

  async remove(path) {
    try {
      await skillsApi.remove(path);
      set(s => ({ skills: s.skills.filter(sk => sk.path !== path) }));
    } catch (err: unknown) {
      set({ error: err instanceof Error ? err.message : '卸载技能失败' });
      throw err;
    }
  },
}));
