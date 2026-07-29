// 测试 Skill API 的安全路径编码，以及重命名成功与失败时的前端状态语义。
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SkillRecord } from '@ema-agent/skills';
import { sidecarClient } from '../src/api/sidecar-client.js';
import { skillsApi } from '../src/api/skills.js';
import { useSkillStore } from '../src/stores/skill-store.js';

function skill(name: string): SkillRecord {
  return {
    id: `id-${name}`,
    name,
    version: '1.0.0',
    description: 'test',
    path: `D:\\skills\\${name}\\SKILL.md`,
    dirPath: `D:\\skills\\${name}`,
    source: 'user',
    sizeBytes: 10,
    enabled: true,
    installedAt: 1,
  };
}

beforeEach(() => {
  useSkillStore.setState({ skills: [skill('旧 技能')], error: null });
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('Skill 管理', () => {
  it('市场安装把发布方 Bundle sha256 原样提交给后端', async () => {
    const request = vi.spyOn(sidecarClient, 'request')
      .mockResolvedValue({ skill: skill('verified') });
    const sha256 = 'a'.repeat(64);
    const coords = {
      owner: 'owner',
      repo: 'repo',
      ref: 'commit',
      dir: 'skills/verified',
    };

    await skillsApi.installFromUrl(
      'https://example.com/verified/SKILL.md',
      coords,
      sha256,
    );

    expect(request).toHaveBeenCalledWith('/api/skills', {
      method: 'POST',
      json: {
        source: 'url',
        url: 'https://example.com/verified/SKILL.md',
        coords,
        sha256,
      },
    });
  });

  it('所有按名称访问的 API 都会编码路径段', async () => {
    const request = vi.spyOn(sidecarClient, 'request').mockResolvedValue({ skill: skill('新技能') });

    await skillsApi.rename('旧 技能/测试', '新技能');

    expect(request).toHaveBeenCalledWith(
      '/api/skills/%E6%97%A7%20%E6%8A%80%E8%83%BD%2F%E6%B5%8B%E8%AF%95/rename',
      { method: 'POST', json: { newName: '新技能' } },
    );
  });

  it('重命名成功后用后端权威记录替换原记录', async () => {
    const renamed = skill('新技能');
    vi.spyOn(skillsApi, 'rename').mockResolvedValue({ skill: renamed });

    await useSkillStore.getState().rename('旧 技能', '新技能');

    expect(useSkillStore.getState().skills).toEqual([renamed]);
    expect(useSkillStore.getState().error).toBeNull();
  });

  it('重命名失败时保留旧记录并向调用方抛错', async () => {
    const failure = new Error('name collision');
    vi.spyOn(skillsApi, 'rename').mockRejectedValue(failure);
    const previous = useSkillStore.getState().skills;

    await expect(useSkillStore.getState().rename('旧 技能', '重复名称')).rejects.toBe(failure);

    expect(useSkillStore.getState().skills).toBe(previous);
    expect(useSkillStore.getState().error).toBe('name collision');
  });
});
