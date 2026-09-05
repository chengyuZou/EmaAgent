// 测试角色切换与删除对 Turn、Compact、普通后台进程和 Memory 边界的应用编排。
import { describe, expect, it, vi } from 'vitest';
import {
  CharacterLastDeleteError,
  CharacterWorkRunningError,
  activateCharacter,
  deleteCharacter,
  type CharacterChangeDeps,
} from '../src/application/changeCharacter.js';

function fixture(running: boolean): CharacterChangeDeps {
  return {
    characters: {
      current: vi.fn(() => ({ name: '当前角色' })),
      list: vi.fn(() => [
        { name: '当前角色', isActive: true },
        { name: '其他角色', isActive: false },
      ]),
      activate: vi.fn(),
      deleteCharacter: vi.fn(async () => 'deleted'),
    },
    activeSessions: {
      activeSessionCount: vi.fn(() => running ? 2 : 0),
      abortAll: vi.fn(async () => undefined),
      runWithRegistrationsClosed: vi.fn(async action => action()),
    },
    backgroundProcesses: {
      hasLiveProcesses: vi.fn(() => running),
      stopAll: vi.fn(async () => undefined),
      runWithProcessStartsClosed: vi.fn(async action => action()),
    },
  } as CharacterChangeDeps;
}

describe('Character change orchestration', () => {
  it('运行中且未确认时拒绝切换，不提前终止工作', async () => {
    const deps = fixture(true);

    await expect(activateCharacter(deps, '新角色', false)).rejects.toBeInstanceOf(CharacterWorkRunningError);
    expect(deps.activeSessions.abortAll).not.toHaveBeenCalled();
    expect(deps.characters.activate).not.toHaveBeenCalled();
  });

  it('确认后并发终止前台执行与普通后台进程，再切换角色', async () => {
    const deps = fixture(true);

    await activateCharacter(deps, '新角色', true);

    expect(deps.activeSessions.abortAll).toHaveBeenCalledOnce();
    expect(deps.backgroundProcesses.stopAll).toHaveBeenCalledOnce();
    expect(deps.characters.activate).toHaveBeenCalledWith('新角色');
  });

  it('删除非当前角色不终止任何执行', async () => {
    const deps = fixture(true);

    await deleteCharacter(deps, '其他角色', false);

    expect(deps.activeSessions.abortAll).not.toHaveBeenCalled();
    expect(deps.backgroundProcesses.stopAll).not.toHaveBeenCalled();
    expect(deps.characters.deleteCharacter).toHaveBeenCalledWith('其他角色', undefined);
  });

  it('删除当前角色后切换到最近使用的剩余角色', async () => {
    const deps = fixture(false);

    await deleteCharacter(deps, '当前角色', false);

    expect(deps.characters.deleteCharacter).toHaveBeenCalledWith('当前角色', '其他角色');
    expect(deps.characters.activate).not.toHaveBeenCalled();
  });

  it('Server 拒绝删除最后一个角色', async () => {
    const deps = fixture(false);
    vi.mocked(deps.characters.list).mockReturnValue([deps.characters.current()]);
    vi.mocked(deps.characters.deleteCharacter).mockResolvedValue('last_character');

    await expect(deleteCharacter(deps, '当前角色', false)).rejects.toBeInstanceOf(CharacterLastDeleteError);
    expect(deps.characters.deleteCharacter).toHaveBeenCalledOnce();
  });
});
