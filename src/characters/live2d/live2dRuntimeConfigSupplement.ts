import type { Live2dRuntimeConfig } from './types.js';
import type { Live2dRuntimeConfigExtraction } from './live2dRuntimeConfigExtraction.js';
import { writeMissingLive2dRuntimeConfigFields } from './live2dRuntimeConfig.js';

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
 * Supplement 把提取出的第三方字段补成 Ema 缺省语义, 例如:
 *
 * ```text
 * model3 Expressions: Name="liulei", File="liulei.exp3.json"
 * vtube Hotkeys:       Name="流泪", Action="ToggleExpression", File="liulei.exp3.json"
 * extraction labels:  ["liulei", "流泪"]
 * runtime-config:     sad -> { expression: "liulei" }
 * ```
 *
 * 同理, model3.json 的 `Motions.Idle[0]` 会补成 `{ group: "Idle", index: 0 }`.
 * 这些都只是首次导入的猜测结果. 写入只补缺失字段和缺失 key, 已有 runtime-config.json
 * 中作者或用户做出的决定不会被覆盖.
 */
export async function supplementLive2dRuntimeConfig(
  modelPath: string,
  runtimeConfigPath: string | null,
  extraction: Live2dRuntimeConfigExtraction,
): Promise<string | null> {
  const supplement: Live2dRuntimeConfig = {};
  const emotionMap: Record<string, { expression: string }> = {};
  for (const expression of extraction.expressions) {
    const emotion = matchEmotion(expression.labels);
    if (emotion && !(emotion in emotionMap)) {
      emotionMap[emotion] = { expression: expression.name };
    }
  }
  if (Object.keys(emotionMap).length > 0) supplement.emotionMap = emotionMap;

  if (extraction.idleMotion) {
    supplement.idleMotions = [extraction.idleMotion];
    supplement.motionMap = { idle: extraction.idleMotion };
  }
  if (!extraction.hasModelLipSync && extraction.vtubeLipSyncParameterIds.length > 0) {
    supplement.lipSyncParameterIds = [...extraction.vtubeLipSyncParameterIds];
  }
  return writeMissingLive2dRuntimeConfigFields(modelPath, runtimeConfigPath, supplement);
}

function matchEmotion(labels: readonly string[]): string | null {
  // 同时尝试 model3 Expression 名与 VTube Studio 热键名，提高常见模型的首次导入可用性。
  for (const label of labels) {
    const normalized = label.toLowerCase().replace(/[\s_-]+/gu, '');
    if (!normalized) continue;
    for (const [emotion, aliases] of EMOTION_ALIASES) {
      if (aliases.includes(normalized)) return emotion;
    }
  }
  return null;
}
