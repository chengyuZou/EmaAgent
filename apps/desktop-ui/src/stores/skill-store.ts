import { create } from 'zustand';
import { skillsApi, type SkillValidateResult } from '../api/skills.js';
import type { SkillRecord } from '@ema-agent/skill';

export type { SkillRecord, SkillValidateResult };

// ── Store interface ───────────────────────────────────────────────────────────

export interface SkillStoreState {
  skills:   Omit<SkillRecord, 'rawMd'>[];
  loading:  boolean;
  error:    string | null;

  /** Load all installed skills. Idempotent — skips if already loaded. */
  load(): Promise<void>;
  /** Force-reload the skill list. */
  refresh(): Promise<void>;

  /** Install a skill from raw markdown text. Refreshes list on success. */
  installFromText(content: string): Promise<Omit<SkillRecord, 'rawMd'>>;
  /** Install a skill from a remote URL. Refreshes list on success. */
  installFromUrl(url: string): Promise<Omit<SkillRecord, 'rawMd'>>;

  /** Validate skill markdown without installing. Returns validation result. */
  validate(content: string): Promise<SkillValidateResult>;

  /** Enable or disable a skill by name. Updates list optimistically. */
  setEnabled(name: string, enabled: boolean): Promise<void>;

  /** Uninstall a skill by name. Refreshes list on success. */
  remove(name: string): Promise<void>;
}

// ── Store ─────────────────────────────────────────────────────────────────────

export const useSkillStore = create<SkillStoreState>((set, get) => ({
  skills:  [],
  loading: false,
  error:   null,

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

  async installFromUrl(url) {
    try {
      const { skill } = await skillsApi.installFromUrl(url);
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
}));
