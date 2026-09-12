// 从 model3.json 提取正式资源身份，并列出模型目录中未登记的表情与动作文件。
import fs from 'node:fs';
import path from 'node:path';
import { CharacterResourceValidationError } from '../errors.js';
import { listLive2dFiles } from './live2dFiles.js';
import type { Live2dNativeMotion } from './types.js';

const REFERENCE_FILE_CHECK_CONCURRENCY = 8;

export interface Live2dModelExpression {
  readonly name: string;
  readonly file: string;
}

export interface Live2dModelResources {
  readonly expressions: readonly Live2dModelExpression[];
  readonly motions: readonly Live2dNativeMotion[];
  readonly unregisteredExpressionFiles: readonly string[];
  readonly unregisteredMotionFiles: readonly string[];
}

/**
 * Cubism `.model3.json` 中本模块读取的结构大致如下:
 *
 * ```json
 * {
 *   "FileReferences": {
 *     "Moc": "ema.moc3",
 *     "Textures": ["ema.8192/texture_00.png"],
 *     "Expressions": [{ "Name": "smile", "File": "smile.exp3.json" }],
 *     "Motions": {
 *       "Idle": [{ "File": "idle.motion3.json", "Sound": "idle.wav" }]
 *     }
 *   },
 *   "Groups": [{ "Name": "LipSync", "Ids": ["ParamMouthOpenY"] }]
 * }
 * ```
 *
 * Expressions 是数组, 原生表情身份来自 `Name`. Motions 是以动作组名为 key 的数组表,
 * 所以一个原生动作必须用 `group + 数组 index` 定位. 文件引用都以 model3.json 所在目录
 * 为根. 提取阶段只保留这些模型原生事实并验证引用文件, 不在这里决定 happy 或 sad 等
 * Ema 语义名. 不在 model3.json 中登记的文件只进入未登记清单,不读取内容也不成为可用资源.
 */
export async function readLive2dModelResources(modelPath: string): Promise<Live2dModelResources> {
  const model = await readModel(modelPath);
  const references = readReferences(model);
  const declaredExpressions = readExpressions(references.Expressions);
  const motions = readMotions(references.Motions);
  const referencedFiles = readRequiredFiles(references);
  for (const expression of declaredExpressions) referencedFiles.push(expression.file);
  for (const motion of motions) {
    referencedFiles.push(motion.file);
    if (motion.sound) referencedFiles.push(motion.sound);
  }
  await assertReferenceFiles(modelPath, referencedFiles);
  const modelDirectory = path.dirname(modelPath);
  const files = await listLive2dFiles(modelDirectory);
  const registeredExpressions = new Set(declaredExpressions.map(expression => fileKey(expression.file)));
  const registeredMotions = new Set(motions.map(motion => fileKey(motion.file)));

  return {
    expressions: declaredExpressions
      .map(expression => ({
        name: expression.name,
        file: normalizeRelativeFile(expression.file),
      })),
    motions: motions.map(({ group, index, file }) => ({ group, index, file: normalizeRelativeFile(file) })),
    unregisteredExpressionFiles: findUnregisteredFiles(
      files,
      modelDirectory,
      '.exp3.json',
      registeredExpressions,
    ),
    unregisteredMotionFiles: findUnregisteredFiles(
      files,
      modelDirectory,
      '.motion3.json',
      registeredMotions,
    ),
  };
}

function findUnregisteredFiles(
  files: readonly string[],
  modelDirectory: string,
  suffix: '.exp3.json' | '.motion3.json',
  registeredFiles: ReadonlySet<string>,
): string[] {
  return files
    .filter(file => file.toLowerCase().endsWith(suffix))
    .map(file => normalizeRelativeFile(path.relative(modelDirectory, file)))
    .filter(file => !registeredFiles.has(fileKey(file)));
}

function fileKey(file: string): string {
  return normalizeRelativeFile(file).toLowerCase();
}

function normalizeRelativeFile(file: string): string {
  return file.replace(/\\/gu, '/');
}

interface ExtractedMotion extends Live2dNativeMotion {
  readonly file: string;
  readonly sound?: string;
}

function readReferences(model: Record<string, unknown>): Record<string, unknown> {
  if (!isRecord(model.FileReferences)) invalidModel();
  return model.FileReferences;
}

function readRequiredFiles(references: Record<string, unknown>): string[] {
  if (!nonEmptyString(references.Moc)
    || !Array.isArray(references.Textures)
    || references.Textures.length === 0
    || !references.Textures.every(nonEmptyString)) {
    invalidModel();
  }
  const files = [references.Moc, ...references.Textures];
  for (const key of ['Physics', 'Pose', 'DisplayInfo', 'UserData'] as const) {
    const value = references[key];
    if (value !== undefined) {
      if (!nonEmptyString(value)) invalidModel();
      files.push(value);
    }
  }
  return files;
}

function readExpressions(value: unknown): { name: string; file: string }[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) invalidModel();
  return value.map(entry => {
    if (!isRecord(entry)
      || !nonEmptyString(entry.Name)
      || !nonEmptyString(entry.File)) {
      invalidModel();
    }
    return {
      name: entry.Name.trim(),
      file: entry.File,
    };
  });
}

function readMotions(value: unknown): ExtractedMotion[] {
  if (value === undefined) return [];
  if (!isRecord(value)) invalidModel();
  const motions: ExtractedMotion[] = [];
  for (const [group, entries] of Object.entries(value)) {
    if (!Array.isArray(entries)) invalidModel();
    entries.forEach((entry, index) => {
      if (!isRecord(entry)
        || !nonEmptyString(entry.File)
        || (entry.Sound !== undefined && !nonEmptyString(entry.Sound))) {
        invalidModel();
      }
      motions.push({
        group,
        index,
        file: entry.File,
        ...(entry.Sound === undefined ? {} : { sound: entry.Sound }),
      });
    });
  }
  return motions;
}

async function readModel(modelPath: string): Promise<Record<string, unknown>> {
  try {
    const parsed: unknown = JSON.parse(await fs.promises.readFile(modelPath, 'utf8'));
    if (!isRecord(parsed)) invalidModel();
    return parsed;
  } catch (error) {
    if (error instanceof CharacterResourceValidationError) throw error;
    return invalidModel();
  }
}

async function assertReferenceFile(modelPath: string, reference: string): Promise<void> {
  // model3.json 的引用以模型文件所在目录为根，不能借绝对路径或 .. 指向资源包外部。
  const normalized = reference.replace(/\\/gu, '/');
  const segments = normalized.split('/');
  if (normalized.startsWith('/')
    || /^[a-z]:/iu.test(normalized)
    || segments.some(segment => !segment || segment === '.' || segment === '..')) {
    throw new CharacterResourceValidationError('live2d_reference_invalid');
  }
  const modelDirectory = path.dirname(modelPath);
  const resolved = path.resolve(modelDirectory, ...segments);
  if (path.relative(modelDirectory, resolved).startsWith('..')) {
    throw new CharacterResourceValidationError('live2d_reference_invalid');
  }
  const stat = await fs.promises.stat(resolved).catch(() => null);
  if (!stat?.isFile()) {
    throw new CharacterResourceValidationError('live2d_reference_invalid');
  }
}

async function assertReferenceFiles(modelPath: string, references: readonly string[]): Promise<void> {
  let nextIndex = 0;
  const workers = Array.from(
    { length: Math.min(REFERENCE_FILE_CHECK_CONCURRENCY, references.length) },
    async () => {
      while (nextIndex < references.length) {
        const reference = references[nextIndex++]!;
        await assertReferenceFile(modelPath, reference);
      }
    },
  );
  await Promise.all(workers);
}

function nonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

function invalidModel(): never {
  throw new CharacterResourceValidationError('live2d_entry_invalid');
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
