import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  memoryRootDir,
  memorySummaryFile,
  relationshipCharacterDir,
  relationshipMemoryDir,
  workMemoryDir,
} from '../common/paths.js';

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('应用数据目录中的 Memory 路径', () => {
  it('未指定目录时使用用户主目录中的 .ema-agent', () => {
    vi.stubEnv('EMA_PROFILE_DIR', undefined);
    expect(memoryRootDir()).toBe(path.join(os.homedir(), '.ema-agent', 'memories'));
  });

  it('所有记忆路径都遵守 EMA_PROFILE_DIR, 不混入默认目录', () => {
    const profileRoot = path.join(os.tmpdir(), 'EmaAgent 路径测试');
    vi.stubEnv('EMA_PROFILE_DIR', profileRoot);
    expect(memoryRootDir()).toBe(path.join(profileRoot, 'memories'));
    expect(workMemoryDir()).toBe(path.join(profileRoot, 'memories', 'work'));
    expect(relationshipMemoryDir()).toBe(path.join(profileRoot, 'memories', 'relationship'));
    expect(relationshipCharacterDir('樱羽艾玛')).toBe(
      path.join(profileRoot, 'memories', 'relationship', 'characters', '樱羽艾玛'),
    );
    expect(memorySummaryFile(workMemoryDir())).toBe(
      path.join(profileRoot, 'memories', 'work', 'memory_summary.md'),
    );
  });
});
