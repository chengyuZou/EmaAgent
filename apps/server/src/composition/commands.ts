import { buildCharacterPrompt } from '@ema-agent/characters';
import {
  compactSession,
  listCommandDescriptors,
  type ManualCompactDeps,
  type ManualCompactResult,
  type CommandDescriptor,
} from '@ema-agent/commands';
import { createCompact, type CompactEvent } from '@ema-agent/compact';
import { createLLMCompletion } from '@ema-agent/llm';
import { MEMORY_GUIDANCE } from '@ema-agent/memory';
import type { CharactersComposition } from './characters.js';
import type { DatabaseComposition } from './database.js';
import type { ProvidersComposition } from './providers.js';
import type { SettingsComposition } from './settings.js';
import type { ToolsComposition } from './tools.js';
import type { TurnComposition } from './turn.js';

export interface CommandsComposition {
  readonly compactSession: (sessionId: string) => Promise<ManualCompactResult>;
  readonly listCommandDescriptors: () => readonly CommandDescriptor[];
}

export function openCommands(deps: {
  database: DatabaseComposition;
  settings: SettingsComposition;
  providers: ProvidersComposition;
  tools: ToolsComposition;
  characters: CharactersComposition;
  turn: TurnComposition;
  publishCompactEvent: (event: CompactEvent) => void;
}): CommandsComposition {
  const { database, settings, providers, tools, characters, turn } = deps;
  const compactDeps: ManualCompactDeps = {
    sessions: database.session,
    turns: database.turns,
    sessionRunning: database.sessionRunning,
    providers: providers.providers,
    providerModels: providers.providerModels,
    settings: settings.settings,
    characterPrompt: () => {
      const character = characters.store.current();
      return buildCharacterPrompt(
        character,
        characters.store.inspectStagePresentation(character.name),
        characters.store.stickers.prompt(character.name),
      );
    },
    skillEntries: (cwd: string, projectId: string | null) => {
      let folderPaths: string[] = [];
      if (projectId) {
        folderPaths = database.session.listProjectFolders(projectId).map((folder) => folder.path);
      } else if (cwd) {
        folderPaths = [cwd];
      }
      return tools.skills.list(folderPaths);
    },
    disabledSkillPaths: () => tools.skillStore.listDisabledPaths(),
    workspaceInstructions: turn.workspaceInstructions,
    memoryGuidance: () => MEMORY_GUIDANCE,
    describeImage: turn.describeImage,
    visionCache: turn.visionCache,
    createCompact,
    createLLMCompletion,
    usageRecorder: database.usageRecorder,
    emit: deps.publishCompactEvent,
    onFinished: (sessionId, status) => {
      turn.continuations.workFinished(sessionId, status === 'cancelled' ? 'aborted' : status);
    },
  };
  return {
    compactSession: sessionId => compactSession(compactDeps, sessionId),
    listCommandDescriptors,
  };
}
