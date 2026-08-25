// 管理已安装 Skill、市场列表及安装、启停、重命名和卸载操作。
import { create } from 'zustand';
import { skillsApi, type SkillValidateResult, type MarketSkillEntry } from '../api/skills.js';
import type { GithubSkillCoords, SkillRecord } from '@ema-agent/skills';

export type { SkillRecord, SkillValidateResult, MarketSkillEntry };

// ── Store interface ───────────────────────────────────────────────────────────

export interface SkillStoreState {
  skills:   Omit<SkillRecord, 'rawMd'>[];
  loading:  boolean;
  error:    string | null;

  marketSkills:  MarketSkillEntry[];
  marketLoading: boolean;
  marketError:   string | null;
  marketSource:  string;

  /** Load all installed skills. Idempotent — skips if already loaded. */
  load(): Promise<void>;
  /** Force-reload the skill list. */
  refresh(): Promise<void>;

  /** Install a skill from raw markdown text. Refreshes list on success. */
  installFromText(content: string): Promise<Omit<SkillRecord, 'rawMd'>>;
  /** Install a skill from a remote URL. Refreshes list on success. */
  installFromUrl(
    url: string,
    coords?: GithubSkillCoords,
    sha256?: string,
  ): Promise<Omit<SkillRecord, 'rawMd'>>;

  /** Validate skill markdown without installing. Returns validation result. */
  validate(content: string): Promise<SkillValidateResult>;

  /** Enable or disable a skill by name. Updates list optimistically. */
  setEnabled(name: string, enabled: boolean): Promise<void>;

  /** Uninstall a skill by name. Refreshes list on success. */
  remove(name: string): Promise<void>;

  /** 重命名可写 Skill；成功响应直接替换本地记录，失败时保留原状态。 */
  rename(name: string, newName: string): Promise<Omit<SkillRecord, 'rawMd'>>;

  /** Fetch installable skills from the market(聚合所有 enabled 源)。Results cached in store. */
  listMarket(): Promise<void>;
}

// ── Store ─────────────────────────────────────────────────────────────────────

export const useSkillStore = create<SkillStoreState>((set, get) => ({
  skills:  [],
  loading: false,
  error:   null,

  marketSkills:  [],
  marketLoading: false,
  marketError:   null,
  marketSource:  '',

  async load() {
    if (get().skills.length > 0) return;
    return get().refresh();
  },

  async refresh() {
    set({ loading: true, error: null });
    try {
      const { skills } = await skillsApi.list();
      set({ skills, loading: false });
    } catch (err: unknown) {
      set({
        error: err instanceof Error ? err.message : 'Failed to load skills',
        loading: false,
      });
    }
  },

  async installFromText(content) {
    try {
      const { skill } = await skillsApi.installFromText(content);
      await get().refresh();
      return skill;
    } catch (err: unknown) {
      set({ error: err instanceof Error ? err.message : 'Failed to install skill' });
      throw err;
    }
  },

  async installFromUrl(url, coords, sha256) {
    try {
      const { skill } = await skillsApi.installFromUrl(url, coords, sha256);
      await get().refresh();
      return skill;
    } catch (err: unknown) {
      set({ error: err instanceof Error ? err.message : 'Failed to install skill from URL' });
      throw err;
    }
  },

  async validate(content) {
    return skillsApi.validate(content);
  },

  async setEnabled(name, enabled) {
    // Optimistic update
    set((s) => ({
      skills: s.skills.map((sk) => sk.name === name ? { ...sk, enabled } : sk),
    }));
    try {
      await skillsApi.setEnabled(name, enabled);
    } catch (err: unknown) {
      // Rollback
      set((s) => ({
        skills: s.skills.map((sk) => sk.name === name ? { ...sk, enabled: !enabled } : sk),
        error: err instanceof Error ? err.message : 'Failed to update skill',
      }));
      throw err;
    }
  },

  async remove(name) {
    try {
      await skillsApi.remove(name);
      set((s) => ({ skills: s.skills.filter((sk) => sk.name !== name) }));
    } catch (err: unknown) {
      set({ error: err instanceof Error ? err.message : 'Failed to remove skill' });
      throw err;
    }
  },

  async rename(name, newName) {
    try {
      const { skill } = await skillsApi.rename(name, newName);
      set((state) => ({
        skills: state.skills.map((item) => item.name === name ? skill : item),
        error: null,
      }));
      return skill;
    } catch (err: unknown) {
      set({ error: err instanceof Error ? err.message : 'Failed to rename skill' });
      throw err;
    }
  },

  async listMarket() {
    set({ marketLoading: true, marketError: null });
    try {
      const res = await skillsApi.listMarket();
      // marketSource 显示参与源数 + 失败源数(供 UI 顶部展示)
      const okCount = res.sources.filter((s) => !s.error).length;
      const errCount = res.sources.filter((s) => s.error).length;
      const sourceLabel = errCount > 0
        ? `${okCount} 个源 · ${errCount} 个失败`
        : `${okCount} 个源`;
      set({ marketSkills: res.skills, marketSource: sourceLabel, marketLoading: false });
    } catch (err: unknown) {
      set({
        marketError:   err instanceof Error ? err.message : 'Failed to load market',
        marketLoading: false,
      });
    }
  },
}));
