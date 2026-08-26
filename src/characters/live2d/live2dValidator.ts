// 发现 Live2D 目录内唯一的模型入口与运行配置，并确认两份 JSON 可以读取。

import fs from 'node:fs';
import path from 'node:path';
import { CharacterResourceValidationError } from '../errors.js';

export interface Live2dPackageFiles {
  readonly modelPath: string;
  readonly runtimeConfigPath: string | null;
}

export function findLive2dPackageFilesSync(directory: string): Live2dPackageFiles {
  let stat: fs.Stats;
  try {
    stat = fs.statSync(directory);
  } catch {
    throw new CharacterResourceValidationError('source_directory_required');
  }
  if (!stat.isDirectory()) {
    throw new CharacterResourceValidationError('source_directory_required');
  }
  const files = listFilesSync(directory);
  const modelPaths = files.filter(file => file.toLowerCase().endsWith('.model3.json'));
  const runtimeConfigPaths = files.filter(
    file => path.basename(file).toLowerCase() === 'runtime-config.json',
  );
  if (modelPaths.length !== 1) {
    throw new CharacterResourceValidationError('live2d_entry_invalid');
  }
  if (runtimeConfigPaths.length > 1) {
    throw new CharacterResourceValidationError('live2d_runtime_config_invalid');
  }
  readJsonObjectSync(modelPaths[0]!, 'live2d_entry_invalid');
  if (runtimeConfigPaths[0]) {
    readJsonObjectSync(runtimeConfigPaths[0], 'live2d_runtime_config_invalid');
  }
  return { modelPath: modelPaths[0]!, runtimeConfigPath: runtimeConfigPaths[0] ?? null };
}

/**
 * 导入时核对 model3.json 声明的每个引用文件真实存在于包内。
 * 结构与 pixi 加载契约一致：FileReferences.Moc 与非空 Textures 是硬要求；
 * 引用路径相对 model3.json 所在目录解析，逃逸包目录或文件缺失都拒绝。
 * 全异步：导入链路不阻塞事件循环（慢盘与杀毒软件实时扫描会放大 stat 尾延迟）。
 */
export async function validateLive2dModelReferences(modelPath: string): Promise<void> {
  let settings: Record<string, unknown>;
  try {
    const value: unknown = JSON.parse(await fs.promises.readFile(modelPath, 'utf8'));
    if (typeof value !== 'object' || value === null || Array.isArray(value)) {
      throw new Error('JSON root is not an object');
    }
    settings = value as Record<string, unknown>;
  } catch {
    throw new CharacterResourceValidationError('live2d_entry_invalid');
  }

  const references = settings.FileReferences;
  if (!isRecord(references)
    || !nonEmptyString(references.Moc)
    || !Array.isArray(references.Textures)
    || references.Textures.length === 0
    || !references.Textures.every(nonEmptyString)) {
    throw new CharacterResourceValidationError('live2d_entry_invalid');
  }

  const declared: string[] = [references.Moc, ...references.Textures];
  for (const optionalKey of ['Physics', 'Pose', 'DisplayInfo', 'UserData'] as const) {
    const value = references[optionalKey];
    if (value !== undefined) {
      if (!nonEmptyString(value)) {
        throw new CharacterResourceValidationError('live2d_entry_invalid');
      }
      declared.push(value);
    }
  }
  if (references.Expressions !== undefined) {
    if (!Array.isArray(references.Expressions)
      || references.Expressions.some(
        entry => !isRecord(entry) || !nonEmptyString(entry.File),
      )) {
      throw new CharacterResourceValidationError('live2d_entry_invalid');
    }
    for (const entry of references.Expressions as { File: string }[]) {
      declared.push(entry.File);
    }
  }
  if (references.Motions !== undefined) {
    if (!isRecord(references.Motions)) {
      throw new CharacterResourceValidationError('live2d_entry_invalid');
    }
    for (const motions of Object.values(references.Motions)) {
      if (!Array.isArray(motions)
        || motions.some(
          entry => !isRecord(entry)
            || !nonEmptyString(entry.File)
            || (entry.Sound !== undefined && !nonEmptyString(entry.Sound)),
        )) {
        throw new CharacterResourceValidationError('live2d_entry_invalid');
      }
      for (const entry of motions as { File: string; Sound?: string }[]) {
        declared.push(entry.File);
        if (entry.Sound !== undefined) declared.push(entry.Sound);
      }
    }
  }

  const modelDirectory = path.dirname(modelPath);
  await Promise.all(
    declared.map(reference => assertReferenceFile(modelDirectory, reference)),
  );
}

async function assertReferenceFile(modelDirectory: string, reference: string): Promise<void> {
  const normalized = reference.replace(/\\/gu, '/');
  const segments = normalized.split('/');
  if (
    normalized.startsWith('/')
    || /^[a-z]:/iu.test(normalized)
    || segments.some(segment => !segment || segment === '.' || segment === '..')
  ) {
    throw new CharacterResourceValidationError('live2d_reference_invalid');
  }
  const resolved = path.resolve(modelDirectory, ...segments);
  if (path.relative(modelDirectory, resolved).startsWith('..')) {
    throw new CharacterResourceValidationError('live2d_reference_invalid');
  }
  const stat = await fs.promises.stat(resolved).catch(() => null);
  if (!stat?.isFile()) {
    throw new CharacterResourceValidationError('live2d_reference_invalid');
  }
}

function listFilesSync(root: string): string[] {
  const result: string[] = [];
  function walk(directory: string): void {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const absolutePath = path.join(directory, entry.name);
      if (entry.isDirectory()) walk(absolutePath);
      else if (entry.isFile()) result.push(absolutePath);
    }
  }
  walk(root);
  return result;
}

function readJsonObjectSync(
  filePath: string,
  reason: 'live2d_entry_invalid' | 'live2d_runtime_config_invalid',
): void {
  try {
    const value: unknown = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    if (typeof value !== 'object' || value === null || Array.isArray(value)) {
      throw new Error('JSON root is not an object');
    }
  } catch {
    throw new CharacterResourceValidationError(reason);
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && Array.isArray(value) === false;
}

function nonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}
