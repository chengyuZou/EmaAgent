// 全局角色变更编排：确认后停止前台执行与普通后台进程，再切换或永久删除角色。
import { CharacterNotFoundError, type CharacterStore } from '@ema-agent/characters';
import type { ActiveSessionRegistry } from '@ema-agent/session';
import type { BackgroundProcess } from '@ema-agent/tools';

export class CharacterWorkRunningError extends Error {
  readonly code = 'character_work_running';

  constructor() {
    super('running turns, compactions, or background processes must be stopped first');
    this.name = 'CharacterWorkRunningError';
  }
}

export class CharacterLastDeleteError extends Error {
  readonly code = 'last_character_cannot_be_deleted';

  constructor(readonly characterName: string) {
    super('the last character cannot be deleted');
    this.name = 'CharacterLastDeleteError';
  }
}

export interface CharacterChangeDeps {
  readonly characters: Pick<CharacterStore, 'current' | 'list' | 'activate' | 'deleteCharacter'>;
  readonly activeSessions: Pick<ActiveSessionRegistry, 'activeSessionCount' | 'abortAll' | 'runWithRegistrationsClosed'>;
  readonly backgroundProcesses: Pick<BackgroundProcess, 'hasLiveProcesses' | 'stopAll' | 'runWithProcessStartsClosed'>;
}

export function characterWorkIsRunning(deps: CharacterChangeDeps): boolean {
  return deps.activeSessions.activeSessionCount() > 0 || deps.backgroundProcesses.hasLiveProcesses();
}

export async function activateCharacter(
  deps: CharacterChangeDeps,
  characterName: string,
  terminateRunningWork: boolean,
): Promise<void> {
  await deps.activeSessions.runWithRegistrationsClosed(() =>
    deps.backgroundProcesses.runWithProcessStartsClosed(async () => {
      if (deps.characters.current().name === characterName) return;
      await stopRunningWork(deps, terminateRunningWork);
      deps.characters.activate(characterName);
    }));
}

export async function deleteCharacter(
  deps: CharacterChangeDeps,
  characterName: string,
  terminateRunningWork: boolean,
): Promise<void> {
  await deps.activeSessions.runWithRegistrationsClosed(() =>
    deps.backgroundProcesses.runWithProcessStartsClosed(async () => {
      const characters = deps.characters.list();
      const target = characters.find(character => character.name === characterName);
      if (!target) throw new CharacterNotFoundError(characterName);
      const replacement = target.isActive
        ? characters.find(character => character.name !== characterName)
        : undefined;
      if (target.isActive) await stopRunningWork(deps, terminateRunningWork);

      const result = await deps.characters.deleteCharacter(characterName, replacement?.name);
      if (result === 'not_found') throw new CharacterNotFoundError(characterName);
      if (result === 'last_character') throw new CharacterLastDeleteError(characterName);
      if (result === 'replacement_not_found') {
        throw new Error('replacement character disappeared during deletion');
      }
    }));
}

export function mutateCharacter<T>(
  deps: CharacterChangeDeps,
  characterName: string,
  action: () => T | Promise<T>,
): Promise<T> {
  return deps.activeSessions.runWithRegistrationsClosed(() => {
    if (deps.characters.current().name === characterName && deps.activeSessions.activeSessionCount() > 0) {
      throw new CharacterWorkRunningError();
    }
    return action();
  });
}

async function stopRunningWork(deps: CharacterChangeDeps, confirmed: boolean): Promise<void> {
  if (!characterWorkIsRunning(deps)) return;
  if (!confirmed) throw new CharacterWorkRunningError();
  await Promise.all([
    deps.activeSessions.abortAll(),
    deps.backgroundProcesses.stopAll(),
  ]);
}
