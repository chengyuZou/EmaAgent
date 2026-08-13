// 有界复制并校验 Live2D/VRM 目录的入口、内部引用、纹理和运行时兼容性。

import fs from 'node:fs';
import path from 'node:path';
import sharp from 'sharp';
import { CharacterResourceValidationError } from '../errors.js';
import { CHARACTER_RESOURCE_LIMITS } from '../resources/characterResourceLimits.js';
import {
  copyDirectoryBounded,
  type CopiedResource,
} from '../resources/characterResourceTransfer.js';
import type { CharacterLive2dFormat } from './types.js';

export interface ValidatedLive2dDirectory extends CopiedResource {
  readonly entryRelativePath: string;
  readonly runtimeConfigRelativePath: string | null;
}

export async function copyAndValidateLive2dDirectory({
  sourceDirectory,
  destinationDirectory,
  format,
  entryRelativePath,
  runtimeConfigRelativePath,
}: {
  sourceDirectory: string;
  destinationDirectory: string;
  format: CharacterLive2dFormat;
  entryRelativePath: string;
  runtimeConfigRelativePath?: string | null;
}): Promise<ValidatedLive2dDirectory> {
  const entry = normalizePackagePath(entryRelativePath);
  const runtimeConfig = runtimeConfigRelativePath
    ? normalizePackagePath(runtimeConfigRelativePath)
    : null;
  const copied = await copyDirectoryBounded(sourceDirectory, destinationDirectory, {
    maxFiles: CHARACTER_RESOURCE_LIMITS.live2dFiles,
    maxSingleFileBytes: CHARACTER_RESOURCE_LIMITS.live2dSingleFileBytes,
    maxTotalBytes: CHARACTER_RESOURCE_LIMITS.live2dTotalBytes,
  });
  try {
    const entryPath = resolvePackageFile(destinationDirectory, entry);
    const entryStat = await fs.promises.stat(entryPath);
    if (!entryStat.isFile()) {
      throw new CharacterResourceValidationError('live2d_entry_invalid');
    }
    if (runtimeConfig) {
      await assertJsonFile(
        resolvePackageFile(destinationDirectory, runtimeConfig),
        'live2d_runtime_config_invalid',
      );
    }

    if (format === 'live2d') {
      await validateCubism(destinationDirectory, entryPath);
    } else {
      await validateVrm(entryPath);
    }
    return {
      ...copied,
      entryRelativePath: entry,
      runtimeConfigRelativePath: runtimeConfig,
    };
  } catch (error) {
    await fs.promises.rm(destinationDirectory, { recursive: true, force: true })
      .catch(() => undefined);
    throw error;
  }
}

async function validateCubism(root: string, entryPath: string): Promise<void> {
  if (!entryPath.toLocaleLowerCase('en-US').endsWith('.model3.json')) {
    throw new CharacterResourceValidationError('live2d_entry_invalid');
  }
  const manifest = await readJsonFile(entryPath);
  const references = extractCubismReferences(manifest);
  if (references.length === 0) {
    throw new CharacterResourceValidationError('live2d_reference_invalid');
  }
  const texturePaths: string[] = [];
  for (const reference of references) {
    if (/^[a-z][a-z0-9+.-]*:/iu.test(reference)) {
      throw new CharacterResourceValidationError('live2d_reference_invalid');
    }
    const normalized = normalizePackagePath(reference);
    const resolved = resolvePackageFile(path.dirname(entryPath), normalized, root);
    let stat: fs.Stats;
    try {
      stat = await fs.promises.stat(resolved);
    } catch {
      throw new CharacterResourceValidationError('live2d_reference_missing');
    }
    if (!stat.isFile()) {
      throw new CharacterResourceValidationError('live2d_reference_missing');
    }
    if (normalized.toLocaleLowerCase('en-US').endsWith('.png')) {
      texturePaths.push(resolved);
    }
  }
  if (texturePaths.length > CHARACTER_RESOURCE_LIMITS.live2dTextures) {
    throw new CharacterResourceValidationError('live2d_texture_invalid');
  }
  for (const texturePath of texturePaths) {
    try {
      const metadata = await sharp(texturePath, {
        animated: false,
        limitInputPixels: CHARACTER_RESOURCE_LIMITS.live2dTextureEdge ** 2,
      }).metadata();
      const width = metadata.width ?? 0;
      const height = metadata.height ?? 0;
      if (
        metadata.format !== 'png'
        || width <= 0
        || height <= 0
        || width > CHARACTER_RESOURCE_LIMITS.live2dTextureEdge
        || height > CHARACTER_RESOURCE_LIMITS.live2dTextureEdge
      ) {
        throw new Error('invalid texture');
      }
    } catch {
      throw new CharacterResourceValidationError('live2d_texture_invalid');
    }
  }
}

async function validateVrm(entryPath: string): Promise<void> {
  if (!entryPath.toLocaleLowerCase('en-US').endsWith('.vrm')) {
    throw new CharacterResourceValidationError('live2d_entry_invalid');
  }
  const descriptor = await fs.promises.open(entryPath, 'r');
  try {
    const header = Buffer.alloc(12);
    const { bytesRead } = await descriptor.read(header, 0, header.length, 0);
    if (bytesRead !== 12 || header.subarray(0, 4).toString('ascii') !== 'glTF') {
      throw new CharacterResourceValidationError('live2d_entry_invalid');
    }
  } finally {
    await descriptor.close();
  }
}

function extractCubismReferences(manifest: Record<string, unknown>): string[] {
  const refs = manifest.FileReferences;
  if (!isRecord(refs)) return [];
  const result: string[] = [];
  pushString(result, refs.Moc);
  pushString(result, refs.Physics);
  pushString(result, refs.Pose);
  pushString(result, refs.DisplayInfo);
  pushString(result, refs.UserData);
  if (Array.isArray(refs.Textures)) {
    for (const texture of refs.Textures) pushString(result, texture);
  }
  for (const key of ['Expressions', 'Motions'] as const) {
    const group = refs[key];
    if (Array.isArray(group)) {
      for (const item of group) if (isRecord(item)) pushString(result, item.File);
    } else if (isRecord(group)) {
      for (const items of Object.values(group)) {
        if (!Array.isArray(items)) continue;
        for (const item of items) if (isRecord(item)) pushString(result, item.File);
      }
    }
  }
  return [...new Set(result)];
}

async function assertJsonFile(
  filePath: string,
  reason: 'live2d_entry_invalid' | 'live2d_runtime_config_invalid',
): Promise<void> {
  await readJsonFile(filePath, reason);
}

async function readJsonFile(
  filePath: string,
  reason: 'live2d_entry_invalid' | 'live2d_runtime_config_invalid' = 'live2d_entry_invalid',
): Promise<Record<string, unknown>> {
  const stat = await fs.promises.stat(filePath);
  if (!stat.isFile() || stat.size > CHARACTER_RESOURCE_LIMITS.live2dManifestBytes) {
    throw new CharacterResourceValidationError(reason);
  }
  try {
    const parsed: unknown = JSON.parse(await fs.promises.readFile(filePath, 'utf8'));
    if (!isRecord(parsed)) throw new Error('not object');
    return parsed;
  } catch {
    throw new CharacterResourceValidationError(reason);
  }
}

function resolvePackageFile(root: string, relative: string, packageRoot = root): string {
  const target = path.resolve(root, ...relative.split('/'));
  const relation = path.relative(path.resolve(packageRoot), target);
  if (
    relation === ''
    || relation === '..'
    || relation.startsWith(`..${path.sep}`)
    || path.isAbsolute(relation)
  ) {
    throw new CharacterResourceValidationError('live2d_reference_invalid');
  }
  return target;
}

function normalizePackagePath(value: string): string {
  if (
    !value
    || path.isAbsolute(value)
    || path.win32.isAbsolute(value)
    || value.includes('\\')
    || value.split('/').some(part => !part || part === '.' || part === '..')
  ) {
    throw new CharacterResourceValidationError('live2d_reference_invalid');
  }
  return value;
}

function pushString(target: string[], value: unknown): void {
  if (typeof value === 'string' && value.length > 0) target.push(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
