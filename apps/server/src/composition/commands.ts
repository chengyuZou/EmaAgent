// Commands 一族：/compact 用例与 Command 目录投影的装配；业务规则全部在 @ema-agent/commands。
import { buildCharacterPrompt } from '@ema-agent/characters';
import {
  compactSession,
  listCommandDescriptors,
  type CommandCompactDeps,
  type CommandCompactResult,
  type CommandDescriptor,
} from '@ema-agent/commands';
import { createCompact } from '@ema-agent/compact';
import { createLlmCall } from '@ema-agent/llm';
import { buildMemoryGuidance } from '@ema-agent/memory';
import type { CharactersComposition } from './characters.js';
import type { DatabaseComposition } from './database.js';
import type { ProvidersComposition } from './providers.js';
import type { SettingsComposition } from './settings.js';
import type { ToolsComposition } from './tools.js';
import type { TurnComposition } from './turn.js';

export interface CommandsComposition {
  readonly compactSession: (sessionId: string) => Promise<CommandCompactResult>;
  readonly listCommandDescriptors: () => readonly CommandDescriptor[];
}

export function openCommands(deps: {
  database: DatabaseComposition;
  settings: SettingsComposition;
  providers: ProvidersComposition;
  tools: ToolsComposition;
  characters: CharactersComposition;
  turn: TurnComposition;
}): CommandsComposition {
  const { database, settings, providers, tools, characters, turn } = deps;
  const compactDeps: CommandCompactDeps = {
    sessions: database.session,
    turns: database.turns,
    activeSessions: database.activeSessions,
    providers: providers.providers,
    providerModels: providers.providerModels,
    attachments: database.attachments,
    settings: settings.settings,
    characterPrompt: () => buildCharacterPrompt(characters.store.current()),
    skillEntries: (workspaceRoot: string) => tools.skills.list(workspaceRoot || undefined),
    workspaceInstructions: turn.workspaceInstructions,
    memoryGuidance: () => buildMemoryGuidance().catch(() => null),
    describeImage: turn.describeImage,
    createCompact,
    createLlmCall,
    usageRecorder: database.usageRecorder,
  };
  return {
    compactSession: sessionId => compactSession(compactDeps, sessionId),
    listCommandDescriptors,
  };
}
