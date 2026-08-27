// 从 model3.json 与可选 .vtube.json 补齐模型包里的 runtime-config.json。
//
// 缺失该文件从不阻塞导入：模型照常渲染，只是没有情绪/动作语义词汇。
// 但舞台渲染时只认这个文件——LLM 产出的语义名（sad）要靠它翻译成模型原生
// 表情/动作（Sad），所以可确定的映射必须落成文件才有持久载体；文件写在
// Ema 自管的资源目录（ZIP 解压副本，不动用户原始包），随 ZIP 导出，用户可
// 直接审阅与手改，写后走 vocabulary 的同一条读取校验路径。
//
// 补写原则：作者已提供的文件只增不删——已声明的键（含空数组/空对象这种
// 明确置空）一律不动，emotionMap/motionMap 只追加作者没有的条目，不认识的
// 字段原样保留；确实补入内容才写回。文件损坏或根不是对象时不补写，交
// vocabulary 校验按既有路径拒绝。
//
// 只写确定性事实：表情/动作名与产品语义表的规范化精确匹配、Idle 组首项、
// VTube 作者配置的 MouthOpen 参数映射。命不中一律留空，由用户在设置页补全；
// 一条都确定不了时不写文件，行为与无配置导入完全一致。

import fs from 'node:fs';
import path from 'node:path';

interface Live2dConfigDraft {
  lipSyncParameterIds?: string[];
  idleMotions?: { group: string; index: number }[];
  emotionMap?: Record<string, { expression: string }>;
  motionMap?: Record<string, { group: string; index: number }>;
}

/**
 * 产品默认情绪词汇与作者常用叫法的对照。
 * 匹配前统一小写并去除空白/下划线/连字符；一个表情只命中第一个情绪，
 * 一个情绪只取 model3.json 中最先出现的表情。
 */
const EMOTION_ALIASES: readonly (readonly [string, readonly string[]])[] = [
  ['neutral', ['neutral', 'normal', '默认', '普通']],
  ['happy', ['happy', 'smile', 'smiling', 'joy', '开心', '笑', '微笑', '高兴']],
  ['curious', ['curious', '好奇']],
  ['shy', ['shy', 'blush', 'blushing', 'embarrassed', '害羞', '脸红']],
  ['sad', ['sad', 'cry', 'crying', 'tears', 'tear', '流泪', '难过', '伤心', '哭']],
  ['scared', ['scared', 'fear', 'afraid', '害怕', '恐惧']],
  ['determined', ['determined', '坚定', '认真']],
  ['focused', ['focused', 'focus', '专注']],
  ['surprised', ['surprised', 'surprise', 'shock', 'shocked', '惊讶', '吃惊']],
  ['angry', ['angry', 'mad', 'furious', '生气', '愤怒', '怒']],
];

/**
 * 补齐 runtime-config.json 并返回其路径；无既有文件且没有可确定条目时不写
 * 文件、返回 null。调用方已确认包内存在合法 model3 入口。
 */
export async function writeLive2dConfigDraft(
  packageDirectory: string,
  modelPath: string,
  runtimeConfigPath: string | null,
): Promise<string | null> {
  const settings: unknown = JSON.parse(await fs.promises.readFile(modelPath, 'utf8'));
  const references = (settings as { FileReferences?: Record<string, unknown> }).FileReferences ?? {};
  const groups = Array.isArray((settings as { Groups?: unknown }).Groups)
    ? (settings as { Groups: { Target?: unknown; Name?: unknown; Ids?: unknown }[] }).Groups
    : [];

  const expressions = (Array.isArray(references.Expressions) ? references.Expressions : [])
    .map(entry => ({
      name: String((entry as { Name?: unknown }).Name ?? '').trim(),
      file: String((entry as { File?: unknown }).File ?? ''),
    }))
    .filter(entry => entry.name && entry.file);
  const motions = isRecord(references.Motions) ? references.Motions : {};

  const vtube = await readVtubeSettings(packageDirectory);
  const hotkeyLabels = new Map<string, string>();
  for (const hotkey of vtube?.hotkeys ?? []) {
    if (hotkey.action !== 'ToggleExpression' || !hotkey.name || !hotkey.file) continue;
    const normalizedFile = normalizeFileKey(hotkey.file);
    hotkeyLabels.set(normalizedFile, hotkey.name);
    const baseName = path.posix.basename(normalizedFile);
    if (!hotkeyLabels.has(baseName)) hotkeyLabels.set(baseName, hotkey.name);
  }

  const emotionMap: Record<string, { expression: string }> = {};
  for (const expression of expressions) {
    const normalizedFile = normalizeFileKey(expression.file);
    const emotion = matchEmotion([
      expression.name,
      hotkeyLabels.get(normalizedFile) ?? '',
      hotkeyLabels.get(path.posix.basename(normalizedFile)) ?? '',
    ]);
    if (emotion && !(emotion in emotionMap)) {
      emotionMap[emotion] = { expression: expression.name };
    }
  }

  const idleGroup = Object.keys(motions).find(
    group => group.toLowerCase() === 'idle' && Array.isArray(motions[group]) && motions[group].length > 0,
  );
  const idleTarget = idleGroup ? { group: idleGroup, index: 0 } : null;

  // 模型未登记 LipSync group 时，VTube 的 MouthOpen 输入映射是唯一可靠的口型来源。
  const lipSyncRegistered = groups.some(
    group => group.Name === 'LipSync' && Array.isArray(group.Ids) && group.Ids.length > 0,
  );
  const lipSyncParameterIds = lipSyncRegistered ? [] : [...new Set(vtube?.lipSyncParameterIds ?? [])];

  const draft: Live2dConfigDraft = {};
  if (lipSyncParameterIds.length > 0) draft.lipSyncParameterIds = lipSyncParameterIds;
  if (idleTarget) draft.idleMotions = [idleTarget];
  if (Object.keys(emotionMap).length > 0) draft.emotionMap = emotionMap;
  if (idleTarget) draft.motionMap = { idle: idleTarget };

  // 作者已提供的文件只增不删：读出现有内容，逐键检测冲突，只补人家没有的。
  const existing = runtimeConfigPath ? await readRuntimeConfigObject(runtimeConfigPath) : null;
  if (runtimeConfigPath && !existing) return runtimeConfigPath;

  const merged: Record<string, unknown> = { ...existing };
  let supplemented = false;
  if (draft.lipSyncParameterIds && merged.lipSyncParameterIds === undefined) {
    merged.lipSyncParameterIds = draft.lipSyncParameterIds;
    supplemented = true;
  }
  if (draft.idleMotions && merged.idleMotions === undefined) {
    merged.idleMotions = draft.idleMotions;
    supplemented = true;
  }
  if (draft.emotionMap) {
    supplemented = mergeMissingEntries(merged, 'emotionMap', draft.emotionMap) || supplemented;
  }
  if (draft.motionMap) {
    supplemented = mergeMissingEntries(merged, 'motionMap', draft.motionMap) || supplemented;
  }
  if (!supplemented) return runtimeConfigPath;

  const target = runtimeConfigPath ?? path.join(path.dirname(modelPath), 'runtime-config.json');
  await fs.promises.writeFile(target, `${JSON.stringify(merged, null, 2)}\n`, 'utf8');
  return target;
}

/** 条目级补缺：键缺失则整表补入；键已存在且为对象时只追加作者没有的条目。 */
function mergeMissingEntries(
  merged: Record<string, unknown>,
  key: 'emotionMap' | 'motionMap',
  computed: Record<string, unknown>,
): boolean {
  const current = merged[key];
  if (current === undefined) {
    merged[key] = computed;
    return true;
  }
  if (!isRecord(current)) return false;
  let added = false;
  for (const [name, target] of Object.entries(computed)) {
    if (!(name in current)) {
      current[name] = target;
      added = true;
    }
  }
  return added;
}

async function readRuntimeConfigObject(runtimeConfigPath: string): Promise<Record<string, unknown> | null> {
  try {
    const parsed: unknown = JSON.parse(await fs.promises.readFile(runtimeConfigPath, 'utf8'));
    return isRecord(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function matchEmotion(candidates: readonly string[]): string | null {
  for (const candidate of candidates) {
    const normalized = normalizeLabel(candidate);
    if (!normalized) continue;
    for (const [emotion, aliases] of EMOTION_ALIASES) {
      if (aliases.includes(normalized)) return emotion;
    }
  }
  return null;
}

function normalizeLabel(value: string): string {
  return value.toLowerCase().replace(/[\s_-]+/gu, '');
}

function normalizeFileKey(value: string): string {
  return value.replace(/\\/gu, '/').toLowerCase();
}

interface VtubeSettings {
  readonly hotkeys: readonly { action: string; name: string; file: string }[];
  readonly lipSyncParameterIds: readonly string[];
}

async function readVtubeSettings(packageDirectory: string): Promise<VtubeSettings | null> {
  const vtubePath = (await listFiles(packageDirectory))
    .find(file => file.toLowerCase().endsWith('.vtube.json'));
  if (!vtubePath) return null;

  try {
    const parsed: unknown = JSON.parse(await fs.promises.readFile(vtubePath, 'utf8'));
    if (!isRecord(parsed)) return null;
    const hotkeys = (Array.isArray(parsed.Hotkeys) ? parsed.Hotkeys : [])
      .map(entry => ({
        action: String((entry as { Action?: unknown }).Action ?? ''),
        name: String((entry as { Name?: unknown }).Name ?? '').trim(),
        file: String((entry as { File?: unknown }).File ?? ''),
      }));
    const lipSyncParameterIds = (Array.isArray(parsed.ParameterSettings) ? parsed.ParameterSettings : [])
      .filter(entry => (entry as { Input?: unknown }).Input === 'MouthOpen')
      .map(entry => String((entry as { OutputLive2D?: unknown }).OutputLive2D ?? '').trim())
      .filter(Boolean);
    return { hotkeys, lipSyncParameterIds };
  } catch {
    // vtube.json 只是草补写的额外参考来源，损坏时按无热键处理，不影响导入。
    return null;
  }
}

async function listFiles(root: string): Promise<string[]> {
  const result: string[] = [];
  async function walk(directory: string): Promise<void> {
    for (const entry of await fs.promises.readdir(directory, { withFileTypes: true })) {
      const absolutePath = path.join(directory, entry.name);
      if (entry.isDirectory()) await walk(absolutePath);
      else if (entry.isFile()) result.push(absolutePath);
    }
  }
  await walk(root);
  return result.sort();
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
