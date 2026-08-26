// 测试 Live2D ZIP 导入导出、稳定物理路径、引用深校验、配置草稿与失败清理语义。

import fs from 'node:fs';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { unzipSync, zipSync } from 'fflate';
import { Database, SettingsRepo } from '@ema-agent/storage';
import { SettingsStore } from '@ema-agent/settings';
import { CharacterStore } from '../store.js';
import { importLive2dZip } from '../live2d/live2dFiles.js';
import { CHARACTER_SETTING_DEFINITIONS } from '../settings.js';

describe('Live2D ZIP resources', () => {
  let database: Database;
  let root: string;
  let store: CharacterStore;
  let characterId: string;

  beforeEach(() => {
    database = new Database({ memory: true, kind: 'profile' });
    database.migrate();
    root = fs.mkdtempSync(path.join(tmpdir(), 'ema-live2d-'));
    const settings = new SettingsStore(new SettingsRepo(database.sqlite), {
      definitions: CHARACTER_SETTING_DEFINITIONS,
      groups: [],
    });
    store = new CharacterStore(database, path.join(root, 'characters'), settings);
    store.ensureSeed();
    characterId = store.create({
      name: 'Alice',
      personaPrompt: 'Alice prompt',
    }).id;
  });

  afterEach(() => {
    database.close();
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('按 ZIP 文件名建立稳定目录并保留包内结构', async () => {
    const sourceZip = writeZip('alice-model.zip', {
      'model/alice.model3.json': model3Bytes({
        Moc: 'alice.moc3',
        Textures: ['textures/texture_00.png'],
      }),
      'model/alice.moc3': new Uint8Array([1, 2, 3]),
      'model/textures/texture_00.png': new Uint8Array([1, 2, 3]),
      'model/runtime-config.json': jsonBytes({
        emotionMap: { happy: { expression: 'happy.exp3.json' } },
        motionMap: { wave: { group: 'Wave', index: 0 } },
      }),
    });

    const imported = await store.importLive2dModel(characterId, { sourceZipFile: sourceZip });
    const resourceDirectory = store.resolveLive2dModelDirectory(characterId, imported.id);

    expect(imported).toMatchObject({
      name: 'alice-model',
      directoryName: 'alice-model',
      emotionVocabulary: ['happy'],
      motionVocabulary: ['wave'],
    });
    expect(resourceDirectory).toBe(path.join(
      root,
      'characters',
      'Alice',
      'live2d',
      'alice-model',
    ));
    expect(fs.existsSync(path.join(resourceDirectory, 'model', 'alice.model3.json'))).toBe(true);
    expect(fs.existsSync(path.join(resourceDirectory, 'model', 'textures', 'texture_00.png'))).toBe(true);
    expect(fs.existsSync(path.join(resourceDirectory, 'alice-model.zip'))).toBe(false);
  });

  it('更改显示名不迁移物理目录，导出文件使用新显示名', async () => {
    const sourceZip = writeZip('stable.zip', {
      'stable.model3.json': model3Bytes({ Moc: 'stable.moc3' }),
      'stable.moc3': new Uint8Array([1]),
      'texture_00.png': new Uint8Array([2]),
    });
    const imported = await store.importLive2dModel(characterId, { sourceZipFile: sourceZip });
    const originalDirectory = store.resolveLive2dModelDirectory(characterId, imported.id);

    store.updateLive2dModel(characterId, imported.id, { name: '新显示名' });
    expect(store.resolveLive2dModelDirectory(characterId, imported.id)).toBe(originalDirectory);

    const exportDirectory = path.join(root, 'exports');
    fs.mkdirSync(exportDirectory);
    const exported = await store.exportLive2dModel(characterId, imported.id, exportDirectory);
    expect(exported).toBe(path.join(exportDirectory, '新显示名.zip'));
    const entries = unzipSync(fs.readFileSync(exported));
    expect(Object.keys(entries)).toEqual(['stable.moc3', 'stable.model3.json', 'texture_00.png']);
  });

  it('缺少 runtime-config.json 时成功导入并使用空词汇', async () => {
    const sourceZip = writeZip('without-runtime.zip', {
      'model.model3.json': model3Bytes(),
      ...modelFiles(),
    });
    const imported = await store.importLive2dModel(characterId, { sourceZipFile: sourceZip });
    expect(imported.emotionVocabulary).toEqual([]);
    expect(imported.motionVocabulary).toEqual([]);
    // 没有可确定条目时不写草稿文件，行为与无配置导入一致
    const resourceDirectory = store.resolveLive2dModelDirectory(characterId, imported.id);
    expect(fs.existsSync(path.join(resourceDirectory, 'runtime-config.json'))).toBe(false);
  });

  it('model3 无运行配置时从表情清单与 vtube 热键生成草稿并入库词汇', async () => {
    const sourceZip = writeZip('natori.zip', {
      'natori.model3.json': model3Bytes(
        {
          Expressions: [
            { Name: 'Angry', File: 'exp/Angry.exp3.json' },
            { Name: 'Blushing', File: 'exp/Blushing.exp3.json' },
            { Name: 'F01', File: 'exp/F01.exp3.json' },
          ],
          Motions: { Idle: [{ File: 'motions/idle_00.motion3.json' }] },
        },
        { Groups: [{ Target: 'Parameter', Name: 'LipSync', Ids: [] }] },
      ),
      ...modelFiles(),
      'exp/Angry.exp3.json': jsonBytes({ Type: 'Live2D Expression', Parameters: [] }),
      'exp/Blushing.exp3.json': jsonBytes({ Type: 'Live2D Expression', Parameters: [] }),
      'exp/F01.exp3.json': jsonBytes({ Type: 'Live2D Expression', Parameters: [] }),
      'motions/idle_00.motion3.json': jsonBytes({}),
      'natori.vtube.json': jsonBytes({
        Hotkeys: [{ Name: '哭', Action: 'ToggleExpression', File: 'exp/F01.exp3.json' }],
        ParameterSettings: [{ Input: 'MouthOpen', OutputLive2D: 'ParamMouthOpenY' }],
      }),
    });

    const imported = await store.importLive2dModel(characterId, { sourceZipFile: sourceZip });
    expect(imported.emotionVocabulary).toEqual(['angry', 'shy', 'sad']);
    expect(imported.motionVocabulary).toEqual(['idle']);

    const resourceDirectory = store.resolveLive2dModelDirectory(characterId, imported.id);
    const draft: unknown = JSON.parse(fs.readFileSync(
      path.join(resourceDirectory, 'runtime-config.json'),
      'utf8',
    ));
    expect(draft).toEqual({
      lipSyncParameterIds: ['ParamMouthOpenY'],
      idleMotions: [{ group: 'Idle', index: 0 }],
      emotionMap: {
        angry: { expression: 'Angry' },
        shy: { expression: 'Blushing' },
        sad: { expression: 'F01' },
      },
      motionMap: { idle: { group: 'Idle', index: 0 } },
    });
  });

  it('model3 引用文件缺失或逃逸包目录时拒绝导入并清理目标目录', async () => {
    const missingReference = writeZip('missing-ref.zip', {
      'model.model3.json': model3Bytes(),
      'model.moc3': new Uint8Array([1, 2, 3, 4]),
      // texture_00.png 缺失
    });
    await expect(store.importLive2dModel(characterId, { sourceZipFile: missingReference }))
      .rejects.toThrow('live2d_reference_invalid');

    const escapingReference = writeZip('escape-ref.zip', {
      'model.model3.json': model3Bytes({ Moc: '../outside.moc3' }),
      'texture_00.png': new Uint8Array([5, 6, 7, 8]),
    });
    await expect(store.importLive2dModel(characterId, { sourceZipFile: escapingReference }))
      .rejects.toThrow('live2d_reference_invalid');

    expect(fs.existsSync(path.join(root, 'characters', 'Alice', 'live2d', 'missing-ref')))
      .toBe(false);
    expect(fs.existsSync(path.join(root, 'characters', 'Alice', 'live2d', 'escape-ref')))
      .toBe(false);
    expect(store.listLive2dModels(characterId)).toEqual([]);
  });

  it('缺少或包含多个 model3 入口时拒绝并清理目标目录', async () => {
    const missingModel = writeZip('missing-model.zip', {
      'readme.txt': new TextEncoder().encode('missing'),
    });
    await expect(store.importLive2dModel(characterId, { sourceZipFile: missingModel }))
      .rejects.toThrow('live2d_entry_invalid');

    const multipleModels = writeZip('multiple-models.zip', {
      'a.model3.json': model3Bytes(),
      'nested/b.model3.json': model3Bytes(),
    });
    await expect(store.importLive2dModel(characterId, { sourceZipFile: multipleModels }))
      .rejects.toThrow('live2d_entry_invalid');

    expect(fs.existsSync(path.join(root, 'characters', 'Alice', 'live2d', 'missing-model')))
      .toBe(false);
    expect(fs.existsSync(path.join(root, 'characters', 'Alice', 'live2d', 'multiple-models')))
      .toBe(false);
    expect(store.listLive2dModels(characterId)).toEqual([]);
  });

  it('超过 ZIP 条目数上限时拒绝并清理目标目录', async () => {
    const sourceZip = writeZip('too-many-entries.zip', {
      'model.model3.json': model3Bytes(),
      'texture.png': new Uint8Array([1]),
    });
    const destinationRoot = path.join(root, 'limited-live2d');

    await expect(importLive2dZip(sourceZip, destinationRoot, {
      maxRuntimeConfigBytes: 1024,
      maxZipEntries: 1,
      maxZipTotalBytes: 1024,
    })).rejects.toThrow('zip_entry_count_exceeded');
    expect(fs.existsSync(path.join(destinationRoot, 'too-many-entries'))).toBe(false);
  });

  it('超过 ZIP 展开字节上限时拒绝并清理目标目录', async () => {
    const sourceZip = writeZip('too-large-expanded.zip', {
      'model.model3.json': model3Bytes(),
    });
    const destinationRoot = path.join(root, 'limited-live2d');

    await expect(importLive2dZip(sourceZip, destinationRoot, {
      maxRuntimeConfigBytes: 1024,
      maxZipEntries: 10,
      maxZipTotalBytes: 1,
    })).rejects.toThrow('zip_expanded_size_exceeded');
    expect(fs.existsSync(path.join(destinationRoot, 'too-large-expanded'))).toBe(false);
  });

  it('同名 ZIP 不覆盖已有资源也不新增 SQL 记录', async () => {
    const sourceZip = writeZip('collision.zip', {
      'model.model3.json': model3Bytes(),
      ...modelFiles(),
    });
    await store.importLive2dModel(characterId, { sourceZipFile: sourceZip });
    await expect(store.importLive2dModel(characterId, { sourceZipFile: sourceZip }))
      .rejects.toThrow('resource_name_conflict');
    expect(store.listLive2dModels(characterId)).toHaveLength(1);
  });

  it('存在但损坏的 runtime-config.json 拒绝导入并删除新目录', async () => {
    const sourceZip = writeZip('broken-runtime.zip', {
      'model.model3.json': model3Bytes(),
      'runtime-config.json': new TextEncoder().encode('{broken'),
    });

    await expect(store.importLive2dModel(characterId, { sourceZipFile: sourceZip }))
      .rejects.toThrow('live2d_runtime_config_invalid');
    expect(fs.existsSync(path.join(
      root,
      'characters',
      'Alice',
      'live2d',
      'broken-runtime',
    ))).toBe(false);
    expect(store.listLive2dModels(characterId)).toEqual([]);
  });

  it('包含路径穿越条目时拒绝并不在目标外写文件', async () => {
    const sourceZip = writeZip('traversal.zip', {
      '../outside.txt': new TextEncoder().encode('outside'),
      'model.model3.json': model3Bytes(),
    });

    await expect(store.importLive2dModel(characterId, { sourceZipFile: sourceZip }))
      .rejects.toThrow('zip_entry_path_invalid');
    expect(fs.existsSync(path.join(root, 'characters', 'Alice', 'live2d', 'traversal'))).toBe(false);
    expect(fs.existsSync(path.join(root, 'characters', 'Alice', 'live2d', 'outside.txt'))).toBe(false);
  });

  it('新主用 Live2D 的运行配置损坏时不切换 SQL 主用项', async () => {
    const first = await store.importLive2dModel(characterId, {
      sourceZipFile: writeZip('first.zip', {
        'model.model3.json': model3Bytes(),
        ...modelFiles(),
      }),
    });
    const second = await store.importLive2dModel(characterId, {
      sourceZipFile: writeZip('second.zip', {
        'model.model3.json': model3Bytes(),
        ...modelFiles(),
        'runtime-config.json': jsonBytes({ motionMap: { wave: { group: 'Wave' } } }),
      }),
    });
    fs.writeFileSync(
      path.join(store.resolveLive2dModelDirectory(characterId, second.id), 'runtime-config.json'),
      '{broken',
    );

    expect(() => store.setPrimaryLive2dModel(characterId, second.id))
      .toThrow('live2d_runtime_config_invalid');
    expect(store.listLive2dModels(characterId).find((resource) => resource.isPrimary)?.id)
      .toBe(first.id);
  });

  it('物理目录被手工删除后仍能删除 SQL 资源记录', async () => {
    const sourceZip = writeZip('missing-on-delete.zip', {
      'model.model3.json': model3Bytes(),
      ...modelFiles(),
    });
    const imported = await store.importLive2dModel(characterId, { sourceZipFile: sourceZip });
    fs.rmSync(store.resolveLive2dModelDirectory(characterId, imported.id), {
      recursive: true,
      force: true,
    });

    await expect(store.deleteLive2dModel(characterId, imported.id)).resolves.toMatchObject({
      id: imported.id,
    });
    expect(store.listLive2dModels(characterId)).toEqual([]);
  });

  it('启动检查同时报告缺失资源和无 SQL 引用的孤儿路径', async () => {
    const sourceZip = writeZip('health.zip', {
      'model.model3.json': model3Bytes(),
      ...modelFiles(),
    });
    const imported = await store.importLive2dModel(characterId, { sourceZipFile: sourceZip });
    fs.rmSync(store.resolveLive2dModelDirectory(characterId, imported.id), {
      recursive: true,
      force: true,
    });
    const orphanedCharacter = path.join(root, 'characters', 'Unknown');
    const orphanedIllustration = path.join(
      root,
      'characters',
      'Alice',
      'illustration',
      'orphan.png',
    );
    fs.mkdirSync(orphanedCharacter, { recursive: true });
    fs.mkdirSync(path.dirname(orphanedIllustration), { recursive: true });
    fs.writeFileSync(orphanedIllustration, 'orphan');

    const report = await store.inspectAllHealth();
    const alice = report.characters.find((health) => health.characterId === characterId)!;
    expect(alice.issues).toContainEqual(expect.objectContaining({
      code: 'resource_missing',
      resourceId: imported.id,
    }));
    expect(report.orphanedPaths).toEqual(expect.arrayContaining([
      orphanedCharacter,
      orphanedIllustration,
    ]));
  });

  function writeZip(fileName: string, entries: Record<string, Uint8Array>): string {
    const filePath = path.join(root, fileName);
    fs.writeFileSync(filePath, zipSync(entries));
    return filePath;
  }
});

function jsonBytes(value: unknown): Uint8Array {
  return new TextEncoder().encode(JSON.stringify(value));
}

/** 满足 pixi 加载契约的最小 model3：FileReferences.Moc + 非空 Textures。 */
function model3Bytes(
  fileReferences: Record<string, unknown> = {},
  extra: Record<string, unknown> = {},
): Uint8Array {
  return jsonBytes({
    Version: 3,
    FileReferences: {
      Moc: 'model.moc3',
      Textures: ['texture_00.png'],
      ...fileReferences,
    },
    ...extra,
  });
}

function modelFiles(): Record<string, Uint8Array> {
  return {
    'model.moc3': new Uint8Array([1, 2, 3, 4]),
    'texture_00.png': new Uint8Array([5, 6, 7, 8]),
  };
}
