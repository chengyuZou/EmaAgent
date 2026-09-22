// 角色切换、删除与会改变正式演出对象的设置写入，在无活跃 Session 时才能提交。
import { CharacterNotFoundError, type CharacterStore } from '@ema-agent/characters';
import type { SessionRunningRegistry } from '@ema-agent/session';

export class CharacterWorkRunningError extends Error {
  readonly code = 'character_work_running';

  constructor() {
    super('an active Turn or Compact must finish before changing the character presentation');
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
  readonly sessionRunning: Pick<SessionRunningRegistry, 'runningSessionCount' | 'runWithRegistrationsClosed'>;
}

export function runWhenSessionsIdle<T>(
  deps: CharacterChangeDeps,
  action: () => T | Promise<T>,
): Promise<T> {
  // 检查和写入必须处于同一个注册关闭期，避免两者之间启动新 Turn 或 Compact。
  return deps.sessionRunning.runWithRegistrationsClosed(() => {
    if (deps.sessionRunning.runningSessionCount() > 0) {
      throw new CharacterWorkRunningError();
    }
    return action();
  });
}

export async function activateCharacter(
  deps: CharacterChangeDeps,
  characterName: string,
): Promise<void> {
  await deps.sessionRunning.runWithRegistrationsClosed(() => {
    if (deps.characters.current().name === characterName) return;
    if (deps.sessionRunning.runningSessionCount() > 0) {
      throw new CharacterWorkRunningError();
    }
    deps.characters.activate(characterName);
  });
}

export async function deleteCharacter(
  deps: CharacterChangeDeps,
  characterName: string,
): Promise<void> {
  await runWhenSessionsIdle(deps, async () => {
    const characters = deps.characters.list();
    const target = characters.find(character => character.name === characterName);
    if (!target) throw new CharacterNotFoundError(characterName);

    const replacement = target.isActive
      ? characters.find(character => character.name !== characterName)
      : undefined;
    const result = await deps.characters.deleteCharacter(characterName, replacement?.name);
    if (result === 'not_found') throw new CharacterNotFoundError(characterName);
    if (result === 'last_character') throw new CharacterLastDeleteError(characterName);
    if (result === 'replacement_not_found') {
      throw new Error('replacement character disappeared during deletion');
    }
  });
}
