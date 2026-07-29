// 测试 Provider 控制面快照定位和模型执行工厂保持无网络启动副作用。

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  createModelCapabilityResolver,
  ModelsDevCatalog,
} from '@ema-agent/provider';
import { Database } from '@ema-agent/storage';
import { createSettingsStore } from '../src/settings/createSettingsStore.js';
import { createModelExecution } from '../src/wiring/createModelExecution.js';
import { loadBundledModelCatalog } from '../src/wiring/createProviderControlPlane.js';
import { createTestCredentialFacade } from './helpers/test-credential-facade.js';

const directories: string[] = [];

function createSnapshot(appRoot: string, snapshotRoot: string): string {
  const moduleDirectory = path.join(appRoot, snapshotRoot, 'wiring');
  fs.mkdirSync(moduleDirectory, { recursive: true });
  return moduleDirectory;
}

function writeValidSnapshot(snapshotPath: string): void {
  fs.writeFileSync(
    snapshotPath,
    JSON.stringify({
      openai: {
        models: {
          'gpt-test': {
            modalities: { input: ['text'], output: ['text'] },
            limit: { context: 16_000 },
          },
        },
      },
    }),
    'utf8',
  );
}

afterEach(() => {
  vi.restoreAllMocks();
  for (const directory of directories.splice(0)) {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

describe('loadBundledModelCatalog', () => {
  it('源码运行时从应用根目录读取快照', () => {
    const appRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ema-catalog-source-'));
    directories.push(appRoot);
    const moduleDirectory = createSnapshot(appRoot, path.join('src'));
    writeValidSnapshot(path.join(appRoot, 'models-dev-snapshot.json'));

    const catalog = loadBundledModelCatalog(moduleDirectory);

    expect(catalog.listLlmModelIds('openai')).toEqual(['gpt-test']);
  });

  it('构建后从 dist 根目录读取快照', () => {
    const appRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ema-catalog-dist-'));
    directories.push(appRoot);
    const moduleDirectory = createSnapshot(appRoot, path.join('dist'));
    writeValidSnapshot(path.join(appRoot, 'dist', 'models-dev-snapshot.json'));

    const catalog = loadBundledModelCatalog(moduleDirectory);

    expect(catalog.listLlmModelIds('openai')).toEqual(['gpt-test']);
  });

  it('空快照保持降级状态且不输出成功日志', () => {
    const appRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ema-catalog-empty-'));
    directories.push(appRoot);
    const moduleDirectory = createSnapshot(appRoot, path.join('dist'));
    fs.writeFileSync(
      path.join(appRoot, 'dist', 'models-dev-snapshot.json'),
      '{}',
      'utf8',
    );
    const info = vi.spyOn(console, 'info').mockImplementation(() => undefined);
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);

    const catalog = loadBundledModelCatalog(moduleDirectory);

    expect(catalog.size).toBe(0);
    expect(info).not.toHaveBeenCalled();
  });
});

describe('createModelExecution', () => {
  it('只构造运行时，不在装配阶段发起模型或 Bridge 网络请求', () => {
    const profileDb = new Database({ memory: true, kind: 'profile' });
    const dataDb = new Database({ memory: true, kind: 'data' });
    profileDb.migrate();
    dataDb.migrate();
    const activeDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ema-models-'));
    directories.push(activeDataDir);
    const fetchSpy = vi.spyOn(globalThis, 'fetch');

    try {
      const { settings } = createSettingsStore(profileDb.sqlite);
      const execution = createModelExecution(
        profileDb,
        dataDb,
        activeDataDir,
        createTestCredentialFacade(),
        settings,
        createModelCapabilityResolver(new ModelsDevCatalog()),
      );

      expect(execution).toMatchObject({
        llm: expect.any(Object),
        embed: expect.any(Object),
        rerank: expect.any(Object),
        narrative: expect.any(Object),
        tts: expect.any(Object),
        stt: expect.any(Object),
        vision: expect.any(Object),
        providerRuntime: expect.any(Object),
        audioArchive: expect.any(Object),
      });
      expect(fetchSpy).not.toHaveBeenCalled();
    } finally {
      dataDb.close();
      profileDb.close();
    }
  });
});
