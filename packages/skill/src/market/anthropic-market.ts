import { GithubSkillMarket } from './github-market.js';
import type { GithubMarketSource } from './types.js';

// ── Anthropic official skills market ──────────────────────────────────────────
//
// The default source. Isolated here on purpose: if Anthropic moves/renames the
// repo or changes the branch, this is the ONLY file to edit — the generic parser
// (github-market.ts) and the registry (index.ts) stay untouched.

export const ANTHROPIC_SOURCE: GithubMarketSource = {
  owner: 'anthropics',
  repo:  'skills',
  ref:   'main',
};

export const anthropicMarket = new GithubSkillMarket(
  'anthropic',
  'Anthropic Skills',
  ANTHROPIC_SOURCE,
);
