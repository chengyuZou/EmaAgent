import type { MarketSkillEntry } from '../types.js';

// ── Skill market abstraction ─────────────────────────────────────────────────
//
// A "market" is any source that can enumerate installable skills (each yielding
// a raw SKILL.md URL the installer can fetch). GitHub repos are one kind; a
// hosted JSON index or a local mirror could be others. New markets implement
// this interface and register in market/index.ts — Anthropic's repo is just the
// default impl, isolated in anthropic-market.ts so a future change there never
// touches the generic parser.

export interface SkillMarket {
  /** Stable id, e.g. 'anthropic'. */
  id:    string;
  /** Human-facing label. */
  label: string;
  /** Enumerate installable skills. */
  list(): Promise<MarketSkillEntry[]>;
}

// ── GitHub-repo source ──────────────────────────────────────────────────────────

export interface GithubMarketSource {
  owner: string;
  repo:  string;
  ref:   string;   // branch or tag
}
