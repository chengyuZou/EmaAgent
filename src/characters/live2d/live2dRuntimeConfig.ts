import fs from 'node:fs';
import path from 'node:path';
import { CharacterResourceValidationError } from '../errors.js';
import type { Live2dMappings, Live2dMotion, Live2dNativeMotion, Live2dRuntimeConfig } from './types.js';

const VOCABULARY_NAME = /^[a-z][a-z0-9_]*$/u;

/**
 * `runtime-config.json` 是 Ema 在 Cubism 文件之外使用的语义配置. 本模块认识的部分如下:
 *
 * ```json
 * {
 *   "emotionMap": {
 *     "happy": { "expression": "smile" },
 *     "neutral": {}
 *   },
 *   "motionMap": { "wave": { "group": "TapBody", "index": 0 } },
 *   "idleMotions": [{ "group": "Idle", "index": 0 }],
 *   "lipSyncParameterIds": ["ParamMouthOpenY"]
 * }
 * ```
 *
 * map 的 key 是 LLM 在 `<emotion>` 或 `<motion>` 中使用的语义词. expression 指向
 * model3.json 的 Expression Name, motion 指向 model3.json 的 group 和数组 index.
 * 空对象表示作者明确禁用该语义词, 因而不会进入 Presentation 词汇. 文件还可能包含
 * 舞台参数等其他作者字段, 读取时不对外暴露, 写映射时原样保留.
 */
export function readLive2dRuntimeConfig(filePath: string | null): Live2dRuntimeConfig {
  if (filePath === null) return {};
  return parseRuntimeConfig(readRuntimeConfigObject(filePath));
}

export async function writeLive2dMappings(
  modelPath: string,
  runtimeConfigPath: string | null,
  mappings: Live2dMappings,
  expressions: readonly string[],
  motions: readonly Live2dNativeMotion[],
): Promise<{ readonly path: string; readonly config: Live2dRuntimeConfig }> {
  // 用户编辑会完整替换两张语义映射，但不改 runtime-config.json 中其他作者字段。
  assertMappings(mappings);
  const expressionNames = new Set(expressions);
  const motionNames = new Set(motions.map(motion => `${motion.group}:${motion.index}`));
  for (const target of Object.values(mappings.emotionMap)) {
    if (!expressionNames.has(target.expression)) invalidMappingTarget();
  }
  for (const target of Object.values(mappings.motionMap)) {
    if (target.index === undefined || !motionNames.has(`${target.group}:${target.index}`)) {
      invalidMappingTarget();
    }
  }
  const document = runtimeConfigPath ? readRuntimeConfigObject(runtimeConfigPath) : {};
  document.emotionMap = mappings.emotionMap;
  document.motionMap = mappings.motionMap;
  const config = parseRuntimeConfig(document);
  const target = runtimeConfigPath ?? path.join(path.dirname(modelPath), 'runtime-config.json');
  await writeRuntimeConfigObject(target, document);
  return { path: target, config };
}

export async function writeMissingLive2dRuntimeConfigFields(
  modelPath: string,
  runtimeConfigPath: string | null,
  missing: Live2dRuntimeConfig,
): Promise<string | null> {
  // 自动补充只填不存在的字段和 key；作者已经写过的内容始终优先。
  const document = runtimeConfigPath ? readRuntimeConfigObject(runtimeConfigPath) : {};
  let changed = false;

  if (missing.lipSyncParameterIds && document.lipSyncParameterIds === undefined) {
    document.lipSyncParameterIds = missing.lipSyncParameterIds;
    changed = true;
  }
  if (missing.idleMotions && document.idleMotions === undefined) {
    document.idleMotions = missing.idleMotions;
    changed = true;
  }
  if (missing.emotionMap) {
    changed = mergeMissingEntries(document, 'emotionMap', missing.emotionMap) || changed;
  }
  if (missing.motionMap) {
    changed = mergeMissingEntries(document, 'motionMap', missing.motionMap) || changed;
  }
  if (!changed) return runtimeConfigPath;

  parseRuntimeConfig(document);
  const target = runtimeConfigPath ?? path.join(path.dirname(modelPath), 'runtime-config.json');
  await writeRuntimeConfigObject(target, document);
  return target;
}

function parseRuntimeConfig(document: Record<string, unknown>): Live2dRuntimeConfig {
  const emotionMap = document.emotionMap === undefined ? undefined : readEmotionMap(document.emotionMap);
  const motionMap = document.motionMap === undefined ? undefined : readMotionMap(document.motionMap);
  if (emotionMap && motionMap) {
    for (const name of Object.keys(motionMap)) {
      if (name in emotionMap) invalidRuntimeConfig();
    }
  }
  return {
    ...(emotionMap ? { emotionMap } : {}),
    ...(motionMap ? { motionMap } : {}),
    ...(document.idleMotions === undefined ? {} : { idleMotions: readMotionList(document.idleMotions) }),
    ...(document.lipSyncParameterIds === undefined ? {} : { lipSyncParameterIds: readParameterIds(document.lipSyncParameterIds) }),
  };
}

function assertMappings(mappings: Live2dMappings): void {
  for (const name of Object.keys(mappings.emotionMap)) assertVocabularyName(name);
  for (const name of Object.keys(mappings.motionMap)) {
    assertVocabularyName(name);
    if (name in mappings.emotionMap) invalidRuntimeConfig();
  }
  readEmotionMap(mappings.emotionMap);
  readMotionMap(mappings.motionMap);
}

function readRuntimeConfigObject(filePath: string): Record<string, unknown> {
  try {
    const parsed: unknown = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    if (!isRecord(parsed)) invalidRuntimeConfig();
    return parsed;
  } catch (error) {
    if (error instanceof CharacterResourceValidationError) throw error;
    return invalidRuntimeConfig();
  }
}

async function writeRuntimeConfigObject(filePath: string, document: Record<string, unknown>): Promise<void> {
  await fs.promises.writeFile(filePath, `${JSON.stringify(document, null, 2)}\n`, 'utf8');
}

function mergeMissingEntries(
  document: Record<string, unknown>,
  key: 'emotionMap' | 'motionMap',
  missing: Record<string, unknown>,
): boolean {
  const current = document[key];
  if (current === undefined) {
    document[key] = missing;
    return true;
  }
  if (!isRecord(current)) invalidRuntimeConfig();
  let changed = false;
  for (const [name, target] of Object.entries(missing)) {
    if (!(name in current)) {
      current[name] = target;
      changed = true;
    }
  }
  return changed;
}

function readEmotionMap(value: unknown): Record<string, { expression: string }> {
  if (!isRecord(value)) invalidRuntimeConfig();
  const map: Record<string, { expression: string }> = {};
  for (const [name, target] of Object.entries(value)) {
    assertVocabularyName(name);
    if (!isRecord(target)) invalidRuntimeConfig();
    // 空对象表示作者主动禁用该语义；有其他内容却没有 expression 才是格式错误。
    if (target.expression === undefined) {
      if (Object.keys(target).length === 0) continue;
      invalidRuntimeConfig();
    }
    if (!nonEmptyString(target.expression)) invalidRuntimeConfig();
    map[name] = { expression: target.expression.trim() };
  }
  return map;
}

function readMotionMap(value: unknown): Record<string, Live2dMotion> {
  if (!isRecord(value)) invalidRuntimeConfig();
  const map: Record<string, Live2dMotion> = {};
  for (const [name, target] of Object.entries(value)) {
    assertVocabularyName(name);
    if (!isRecord(target)) invalidRuntimeConfig();
    // Motion 的空对象同样表示主动置空，不进入 Presentation 词汇。
    if (Object.keys(target).length === 0) continue;
    map[name] = readMotion(target);
  }
  return map;
}

function readMotionList(value: unknown): Live2dMotion[] {
  if (!Array.isArray(value)) invalidRuntimeConfig();
  return value.map(readMotion);
}

function readMotion(value: unknown): Live2dMotion {
  if (!isRecord(value) || !nonEmptyString(value.group)) invalidRuntimeConfig();
  if (value.index !== undefined
    && (typeof value.index !== 'number' || !Number.isInteger(value.index) || value.index < 0)) {
    invalidRuntimeConfig();
  }
  return {
    group: value.group.trim(),
    ...(value.index === undefined ? {} : { index: value.index }),
  };
}

function readParameterIds(value: unknown): string[] {
  if (!Array.isArray(value)) invalidRuntimeConfig();
  return value.map(item => {
    if (!nonEmptyString(item)) invalidRuntimeConfig();
    return item.trim();
  });
}

function assertVocabularyName(value: string): void {
  if (!VOCABULARY_NAME.test(value)) invalidRuntimeConfig();
}

function nonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

function invalidRuntimeConfig(): never {
  throw new CharacterResourceValidationError('live2d_runtime_config_invalid');
}

function invalidMappingTarget(): never {
  throw new CharacterResourceValidationError('live2d_mapping_target_invalid');
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
