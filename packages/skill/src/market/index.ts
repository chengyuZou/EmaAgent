import type { MarketSkillEntry } from '../types.js';
import type { GithubMarketSource, SkillMarket } from './types.js';
import { GithubSkillMarket } from './github-market.js';
import { anthropicMarket } from './anthropic-market.js';

export type { SkillMarket, GithubMarketSource } from './types.js';
export { GithubSkillMarket } from './github-market.js';
export { anthropicMarket, ANTHROPIC_SOURCE } from './anthropic-market.js';

// ── Registry ──────────────────────────────────────────────────────────────────
//
// Built-in markets, keyed by id. Add a new source = add one entry here (and a
// file like anthropic-market.ts). Ad-hoc GitHub repos don't need registration —
// use marketFromGithub() directly.

export const DEFAULT_MARKET_ID = anthropicMarket.id;

export const MARKETS: Record<string, SkillMarket> = {
  [anthropicMarket.id]: anthropicMarket,
};

export function getMarket(id: string = DEFAULT_MARKET_ID): SkillMarket | null {
  return MARKETS[id] ?? null;
}

/** Build a one-off market for an arbitrary GitHub repo (not registered). */
export function marketFromGithub(source: GithubMarketSource): SkillMarket {
  return new GithubSkillMarket(`github:${source.owner}/${source.repo}`, `${source.owner}/${source.repo}`, source);
}

/** List skills from a registered market by id (default: Anthropic). */
export async function listMarketSkills(marketId: string = DEFAULT_MARKET_ID): Promise<MarketSkillEntry[]> {
  const market = getMarket(marketId);
  if (!market) throw new Error(`Unknown skill market: ${marketId}`);
  return market.list();
}
