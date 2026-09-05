import fs from 'node:fs';
import path from 'node:path';
import { CharacterResourceValidationError } from '../errors.js';
import type { Live2dNativeMotion } from './types.js';
import { listLive2dFiles } from './live2dFiles.js';

const REFERENCE_FILE_CHECK_CONCURRENCY = 8;

export interface ExtractedLive2dExpression {
  readonly name: string;
  readonly file: string;
  readonly labels: readonly string[];
}

export interface Live2dRuntimeConfigExtraction {
  readonly expressions: readonly ExtractedLive2dExpression[];
  readonly motions: readonly Live2dNativeMotion[];
  readonly idleMotion: Live2dNativeMotion | null;
  readonly hasModelLipSync: boolean;
  readonly vtubeLipSyncParameterIds: readonly string[];
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
 * Ema 语义名.
 */
export async function extractLive2dRuntimeConfig(
  live2dDirectory: string,
  modelPath: string,
): Promise<Live2dRuntimeConfigExtraction> {
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

  // VTube Studio 热键名只作为 Expression 的额外标签，最终语义匹配交给 Supplement。
  const vtube = await extractVtubeConfig(live2dDirectory);
  const labels = new Map<string, string>();
  for (const hotkey of vtube.hotkeys) {
    const normalizedFile = normalizeFileKey(hotkey.file);
    labels.set(normalizedFile, hotkey.name);
    const baseName = path.posix.basename(normalizedFile);
    if (!labels.has(baseName)) labels.set(baseName, hotkey.name);
  }

  const expressionsWithLabels = declaredExpressions.filter(expression => expression.name).map(expression => {
    const normalizedFile = normalizeFileKey(expression.file);
    return {
      ...expression,
      labels: [
        expression.name,
        labels.get(normalizedFile) ?? '',
        labels.get(path.posix.basename(normalizedFile)) ?? '',
      ].filter(Boolean),
    };
  });
  const idleMotion = motions.find(motion => motion.group.toLowerCase() === 'idle') ?? null;
  return {
    expressions: expressionsWithLabels,
    motions: motions.map(({ group, index }) => ({ group, index })),
    idleMotion: idleMotion ? { group: idleMotion.group, index: idleMotion.index } : null,
    hasModelLipSync: readModelLipSync(model),
    vtubeLipSyncParameterIds: vtube.lipSyncParameterIds,
  };
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
    if (!isRecord(entry) || !nonEmptyString(entry.File)) invalidModel();
    return {
      name: nonEmptyString(entry.Name) ? entry.Name.trim() : '',
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

function readModelLipSync(model: Record<string, unknown>): boolean {
  if (!Array.isArray(model.Groups)) return false;
  return model.Groups.some(group => isRecord(group)
    && group.Name === 'LipSync'
    && Array.isArray(group.Ids)
    && group.Ids.length > 0);
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

interface VtubeConfig {
  readonly hotkeys: readonly { action: string; name: string; file: string }[];
  readonly lipSyncParameterIds: readonly string[];
}

/**
 * `.vtube.json` 是 VTube Studio 的可选旁路配置. 本模块只借用下面两个子结构:
 *
 * ```json
 * {
 *   "Hotkeys": [
 *     { "Action": "ToggleExpression", "Name": "开心", "File": "smile.exp3.json" }
 *   ],
 *   "ParameterSettings": [
 *     { "Input": "MouthOpen", "OutputLive2D": "ParamMouthOpenY" }
 *   ]
 * }
 * ```
 *
 * 热键的 `Name` 是人写的标签, 有时比 model3.json 的 Expression Name 更有语义.
 * `File` 在真实资源中既可能是相对路径也可能只是文件名, 因此上面同时按标准化路径
 * 和 basename 关联表情. MouthOpen 的 `OutputLive2D` 则是模型实际接收口型值的参数 ID.
 */
async function extractVtubeConfig(live2dDirectory: string): Promise<VtubeConfig> {
  const vtubePath = (await listLive2dFiles(live2dDirectory))
    .find(file => file.toLowerCase().endsWith('.vtube.json'));
  if (!vtubePath) return { hotkeys: [], lipSyncParameterIds: [] };
  try {
    const parsed: unknown = JSON.parse(await fs.promises.readFile(vtubePath, 'utf8'));
    
    if (!isRecord(parsed)) return { hotkeys: [], lipSyncParameterIds: [] };
    const hotkeys = (Array.isArray(parsed.Hotkeys) ? parsed.Hotkeys : []).map(entry => ({
      action: String((entry as { Action?: unknown }).Action ?? ''),
      name: String((entry as { Name?: unknown }).Name ?? '').trim(),
      file: String((entry as { File?: unknown }).File ?? ''),
    })).filter(hotkey => hotkey.action === 'ToggleExpression' && hotkey.name && hotkey.file);

    const lipSyncParameterIds = (Array.isArray(parsed.ParameterSettings) ? parsed.ParameterSettings : [])
      .filter(entry => (entry as { Input?: unknown }).Input === 'MouthOpen')
      .map(entry => String((entry as { OutputLive2D?: unknown }).OutputLive2D ?? '').trim())
      .filter(Boolean);

    return { hotkeys, lipSyncParameterIds: [...new Set(lipSyncParameterIds)] };
  } catch {
    // .vtube.json 是可选辅助信息；损坏时放弃辅助标签，不影响有效 model3.json 的导入。
    return { hotkeys: [], lipSyncParameterIds: [] };
  }
}

function normalizeFileKey(value: string): string {
  return value.replace(/\\/gu, '/').toLowerCase();
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
