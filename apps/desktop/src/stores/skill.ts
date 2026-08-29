// 管理已安装 Skill 目录（含 enabled 投影）、启停开关与市场站点。
// 启停唯一写路径是 settings 的 skill.disabledKeys deny-list；安装只走站点缓存索引。
import { create } from 'zustand';
import {
  skillsApi,
  type SkillListItem,
  type SkillSiteRecord,
  type SkillSiteAddInput,
  type SkillSitePatchInput,
  type SkillInstallResult,
  type SkillSitesRefreshResult,
} from '../api/skills.js';
import { settingsApi } from '../api/settings.js';

const DISABLED_KEYS_SETTING = 'skill.disabledKeys';

// ── Store interface ───────────────────────────────────────────────────────────

export interface SkillStoreState {
  skills:   SkillListItem[];
  loading:  boolean;
  error:    string | null;

  sites:       SkillSiteRecord[];
  sitesLoading: boolean;
  sitesError:  string | null;

  /** 装载全部已安装技能。幂等——已装载则跳过。 */
  load(): Promise<void>;
  /** 强制重读技能目录。 */
  refresh(): Promise<void>;

  /** 逐技能启停：写 skill.disabledKeys deny-list 后重读目录投影。 */
  setEnabled(key: string, enabled: boolean): Promise<void>;

  /** 卸载一个 user Skill（builtin 只读、project 跟随工作区，服务端会拒绝）。 */
  remove(key: string): Promise<void>;

  // ── 市场站点 ──────────────────────────────────────────────────────────────

  loadSites(): Promise<void>;
  addSite(input: SkillSiteAddInput): Promise<void>;
  patchSite(id: string, patch: SkillSitePatchInput): Promise<void>;
  removeSite(id: string): Promise<void>;
  /** 全站刷新索引；各站成败独立报告。 */
  refreshSites(): Promise<SkillSitesRefreshResult>;
  /** 以站点缓存索引条目安装；成功后重读技能目录。 */
  installFromSite(siteId: string, entryId: string): Promise<SkillInstallResult>;
}

// ── Store ─────────────────────────────────────────────────────────────────────

export const useSkillStore = create<SkillStoreState>((set, get) => ({
  skills:  [],
  loading: false,
  error:   null,

  sites:        [],
  sitesLoading: false,
  sitesError:   null,

  async load() {
    if (get().skills.length > 0) return;
    return get().refresh();
  },

  async refresh() {
    set({ loading: true, error: null });
    try {
      const { items } = await skillsApi.list();
      set({ skills: [...items], loading: false });
    } catch (err: unknown) {
      set({
        error: err instanceof Error ? err.message : '加载技能列表失败',
        loading: false,
      });
    }
  },

  async setEnabled(key, enabled) {
    // 乐观翻转让开关立即响应；deny-list 落库后重读服务端目录投影收口
    // （enabled 由 deny 三开关联合判定，单键翻转未必改变结果）。
    set((s) => ({
      skills: s.skills.map((sk) => sk.key === key ? { ...sk, enabled } : sk),
    }));
    try {
      const { value } = await settingsApi.getValue(DISABLED_KEYS_SETTING);
      const current = Array.isArray(value)
        ? value.filter((k): k is string => typeof k === 'string')
        : [];
      const next = enabled
        ? current.filter((k) => k !== key)
        : [...new Set([...current, key])];
      await settingsApi.putValue(DISABLED_KEYS_SETTING, next);
      await get().refresh();
    } catch (err: unknown) {
      // 失败回滚到翻转前。
      set((s) => ({
        skills: s.skills.map((sk) => sk.key === key ? { ...sk, enabled: !enabled } : sk),
        error: err instanceof Error ? err.message : '更新技能开关失败',
      }));
      throw err;
    }
  },

  async remove(key) {
    try {
      await skillsApi.remove(key);
      set((s) => ({ skills: s.skills.filter((sk) => sk.key !== key) }));
    } catch (err: unknown) {
      set({ error: err instanceof Error ? err.message : '卸载技能失败' });
      throw err;
    }
  },

  // ── 市场站点 ──────────────────────────────────────────────────────────────

  async loadSites() {
    set({ sitesLoading: true, sitesError: null });
    try {
      const { items } = await skillsApi.listSites();
      set({ sites: [...items], sitesLoading: false });
    } catch (err: unknown) {
      set({
        sitesError: err instanceof Error ? err.message : '加载站点列表失败',
        sitesLoading: false,
      });
    }
  },

  async addSite(input) {
    try {
      await skillsApi.addSite(input);
      await get().loadSites();
    } catch (err: unknown) {
      set({ sitesError: err instanceof Error ? err.message : '添加站点失败' });
      throw err;
    }
  },

  async patchSite(id, patch) {
    try {
      await skillsApi.patchSite(id, patch);
      await get().loadSites();
    } catch (err: unknown) {
      set({ sitesError: err instanceof Error ? err.message : '更新站点失败' });
      throw err;
    }
  },

  async removeSite(id) {
    try {
      await skillsApi.removeSite(id);
      set((s) => ({ sites: s.sites.filter((site) => site.id !== id) }));
    } catch (err: unknown) {
      set({ sitesError: err instanceof Error ? err.message : '移除站点失败' });
      throw err;
    }
  },

  async refreshSites() {
    set({ sitesLoading: true, sitesError: null });
    try {
      const result = await skillsApi.refreshSites();
      await get().loadSites();
      return result;
    } catch (err: unknown) {
      set({
        sitesError: err instanceof Error ? err.message : '刷新站点索引失败',
        sitesLoading: false,
      });
      throw err;
    }
  },

  async installFromSite(siteId, entryId) {
    try {
      const result = await skillsApi.installFromSite({ siteId, entryId });
      await get().refresh();
      return result;
    } catch (err: unknown) {
      set({ error: err instanceof Error ? err.message : '安装技能失败' });
      throw err;
    }
  },
}));
