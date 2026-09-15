import fs from 'node:fs';
import path from 'node:path';
import { CharacterResourceValidationError } from '../errors.js';
import type {
  Live2dMappings,
  Live2dMotion,
  Live2dNativeMotion,
  Live2dRuntimeConfig,
} from './types.js';

const VOCABULARY_NAME = /^[a-z][a-z0-9_]*$/u;
const RUNTIME_CONFIG_KEYS = new Set(['emotionMap', 'motionMap']);

/**
 * `runtime-config.json` 是 Ema 在 Cubism 文件之外使用的语义配置. 本模块认识的部分如下:
 *
 * ```json
 * {
 *   "emotionMap": {
 *     "happy": { "expression": "smile" },
 *     "neutral": {}
 *   },
 *   "motionMap": { "wave": { "group": "TapBody", "index": 0 } }
 * }
 * ```
 *
 * map 的 key 是 LLM 在 `<emotion>` 或 `<motion>` 中使用的语义词. expression 指向
 * model3.json 的 Expression Name, motion 指向 model3.json 的 group 和数组 index.
 * 空对象表示作者明确禁用该语义词, 因而不会进入 Presentation 词汇. 模型原生能力只从
 * model3.json 读取,本文件不重复登记待机 Motion 或口型 Parameter.
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
  // 保存时重写完整语义配置,避免已经失去消费方的旧字段继续伪装成模型能力来源.
  assertMappings(mappings);
  const expressionNames = new Set(expressions);
  const motionNames = new Set(motions.map(motion => `${motion.group}:${motion.index}`));
  for (const target of Object.values(mappings.emotionMap)) {
    if (!expressionNames.has(target.expression)) invalidMappingTarget();
  }
  for (const target of Object.values(mappings.motionMap)) {
    if (!motionNames.has(`${target.group}:${target.index}`)) {
      invalidMappingTarget();
    }
  }
  const existing = runtimeConfigPath ? readRuntimeConfigObject(runtimeConfigPath) : {};
  const document = {
    emotionMap: keepDisabledMappings(existing.emotionMap, mappings.emotionMap),
    motionMap: keepDisabledMappings(existing.motionMap, mappings.motionMap),
  };
  const config = parseRuntimeConfig(document);
  const target = runtimeConfigPath ?? path.join(path.dirname(modelPath), 'runtime-config.json');
  await writeRuntimeConfigObject(target, document);
  return { path: target, config };
}

function parseRuntimeConfig(document: Record<string, unknown>): Live2dRuntimeConfig {
  if (Object.keys(document).some(key => !RUNTIME_CONFIG_KEYS.has(key))) {
    invalidRuntimeConfig();
  }
  const emotionMap = document.emotionMap === undefined ? undefined : readEmotionMap(document.emotionMap);
  const motionMap = document.motionMap === undefined ? undefined : readMotionMap(document.motionMap);
  return {
    ...(emotionMap ? { emotionMap } : {}),
    ...(motionMap ? { motionMap } : {}),
  };
}

function assertMappings(mappings: Live2dMappings): void {
  for (const name of Object.keys(mappings.emotionMap)) assertVocabularyName(name);
  for (const name of Object.keys(mappings.motionMap)) assertVocabularyName(name);
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

function keepDisabledMappings<T>(existing: unknown, active: Readonly<Record<string, T>>): Record<string, unknown> {
  if (!isRecord(existing)) return { ...active };
  const disabled = Object.fromEntries(
    Object.entries(existing).filter(([, target]) => isRecord(target) && Object.keys(target).length === 0),
  );
  return { ...disabled, ...active };
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

function readMotion(value: unknown): Live2dMotion {
  if (!isRecord(value)
    || !nonEmptyString(value.group)
    || typeof value.index !== 'number'
    || !Number.isInteger(value.index)
    || value.index < 0) {
    invalidRuntimeConfig();
  }
  return { group: value.group.trim(), index: value.index };
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
