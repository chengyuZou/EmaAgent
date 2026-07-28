// 测试 Skill 重命名返回权威记录，并确认 V1 的移动路由不会伪造成功。
import { describe, expect, it, vi } from 'vitest';
import type { SkillRecord } from '@ema-agent/skills';
import { createSkillsRouter } from '../src/routes/skills.js';

type SkillStoreArg = Parameters<typeof createSkillsRouter>[0];
type SkillInstallerArg = Parameters<typeof createSkillsRouter>[1];
type MarketSourcesArg = Parameters<typeof createSkillsRouter>[2];
type MarketRegistryArg = Parameters<typeof createSkillsRouter>[3];

function skill(name: string): SkillRecord {
  return {
    id: 'skill-id',
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

function createApp() {
  let current = skill('旧技能');
  const skillStore: SkillStoreArg = {
    listAll: vi.fn(() => [current]),
    findByName: vi.fn((name: string) => (name === current.name ? current : null)),
    readRawMd: vi.fn(async () => ''),
    setEnabled: vi.fn(),
    rename: vi.fn(async (_oldName: string, newName: string) => {
      current = skill(newName);
    }),
    remove: vi.fn(async () => {}),
  };
  const skillInstaller: SkillInstallerArg = {
    installFromUrl: vi.fn(),
    installFromText: vi.fn(),
    validate: vi.fn(),
  };
  const marketSources: MarketSourcesArg = {
    listEnabled: vi.fn(() => []),
  };
  const marketRegistry: MarketRegistryArg = {
    listAll: vi.fn(async () => []),
  };
  const app = createSkillsRouter(
    skillStore,
    skillInstaller,
    marketSources,
    marketRegistry,
  );
  return { app, skillStore };
}

describe('Skill 管理路由', () => {
  it('重命名会裁剪首尾空白并返回新的权威记录', async () => {
    const { app, skillStore } = createApp();
    const response = await app.request('/skills/%E6%97%A7%E6%8A%80%E8%83%BD/rename', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ newName: '  新技能  ' }),
    });

    expect(response.status).toBe(200);
    expect(skillStore.rename).toHaveBeenCalledWith('旧技能', '新技能');
    await expect(response.json()).resolves.toMatchObject({ skill: { name: '新技能' } });
  });

  it('拒绝空名称和超过 128 字符的名称', async () => {
    const { app, skillStore } = createApp();
    const empty = await app.request('/skills/old/rename', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ newName: '   ' }),
    });
    const tooLong = await app.request('/skills/old/rename', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ newName: 'a'.repeat(129) }),
    });

    expect(empty.status).toBe(400);
    expect(tooLong.status).toBe(400);
    expect(skillStore.rename).not.toHaveBeenCalled();
  });

  it('V1 移动路由显式返回 501，绝不把无操作伪装为成功', async () => {
    const { app } = createApp();
    const response = await app.request('/skills/old/relocate', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ dir: 'D:\\other-skills' }),
    });

    expect(response.status).toBe(501);
    await expect(response.json()).resolves.toMatchObject({
      error: 'skill_relocation_unavailable',
    });
  });
});
