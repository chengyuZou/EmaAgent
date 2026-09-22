// 测试活跃 Session 对角色切换、删除和指定设置写入的统一门禁。
import { describe, expect, it, vi } from 'vitest';
import {
  CharacterLastDeleteError,
  CharacterWorkRunningError,
  activateCharacter,
  deleteCharacter,
  runWhenSessionsIdle,
  type CharacterChangeDeps,
} from '../src/application/changeCharacter.js';

function fixture(runningSessionCount: number): CharacterChangeDeps {
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
    sessionRunning: {
      runningSessionCount: vi.fn(() => runningSessionCount),
      runWithRegistrationsClosed: vi.fn(async action => action()),
    },
  } as CharacterChangeDeps;
}

describe('Character change orchestration', () => {
  it('活跃 Session 期间拒绝切换角色', async () => {
    const deps = fixture(2);

    await expect(activateCharacter(deps, '新角色')).rejects.toBeInstanceOf(CharacterWorkRunningError);
    expect(deps.characters.activate).not.toHaveBeenCalled();
  });

  it('已经是当前角色时不产生切换', async () => {
    const deps = fixture(2);

    await activateCharacter(deps, '当前角色');

    expect(deps.characters.activate).not.toHaveBeenCalled();
  });

  it('活跃 Session 期间拒绝删除非当前角色', async () => {
    const deps = fixture(1);

    await expect(deleteCharacter(deps, '其他角色')).rejects.toBeInstanceOf(CharacterWorkRunningError);
    expect(deps.characters.deleteCharacter).not.toHaveBeenCalled();
  });

  it('无活跃 Session 时删除当前角色并指定替代角色', async () => {
    const deps = fixture(0);

    await deleteCharacter(deps, '当前角色');

    expect(deps.characters.deleteCharacter).toHaveBeenCalledWith('当前角色', '其他角色');
  });

  it('Server 拒绝删除最后一个角色', async () => {
    const deps = fixture(0);
    vi.mocked(deps.characters.list).mockReturnValue([deps.characters.current()]);
    vi.mocked(deps.characters.deleteCharacter).mockResolvedValue('last_character');

    await expect(deleteCharacter(deps, '当前角色')).rejects.toBeInstanceOf(CharacterLastDeleteError);
    expect(deps.characters.deleteCharacter).toHaveBeenCalledOnce();
  });

  it('门禁在关闭新 Session 注册期间完成检查和写入', async () => {
    const deps = fixture(0);
    const action = vi.fn(() => 'saved');

    await expect(runWhenSessionsIdle(deps, action)).resolves.toBe('saved');
    expect(deps.sessionRunning.runWithRegistrationsClosed).toHaveBeenCalledOnce();
    expect(action).toHaveBeenCalledOnce();
  });
});
