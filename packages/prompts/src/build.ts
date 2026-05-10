import type { TurnMode, AgentSubMode } from '@ema-agent/contracts';
import type { CharacterCard } from '@ema-agent/character-card';
import { buildSystemBlock } from '@ema-agent/character-card';
import { buildModeBlock } from './mode-blocks.js';

export interface BuildSystemPromptOpts {
  agentSubMode?: AgentSubMode;
  /** Absolute paths to all workspace roots the agent may operate in. */
  workspaceRoots?: string[];
}

/**
 * Assemble the full system prompt for a turn.
 *
 * Structure:
 *   ① Character block  — persona + ACT tag vocabulary  (from character-card)
 *   ② Mode block       — behavioural constraints for chat / narrative / agent
 *
 * Note: memory recall is NOT injected here. Per architecture, RecallBundle is
 * appended as a separate `user`-role context message by the orchestrator, so
 * the system prefix stays stable and benefits from prompt caching.
 */
export function buildSystemPrompt(
  card: CharacterCard,
  mode: TurnMode,
  opts: BuildSystemPromptOpts = {},
): string {
  const characterBlock = buildSystemBlock(card);
  const modeBlock = buildModeBlock(mode, {
    agentSubMode: opts.agentSubMode,
    workspaceRoots: opts.workspaceRoots,
  });

  return `${characterBlock}\n\n${modeBlock}`;
}
