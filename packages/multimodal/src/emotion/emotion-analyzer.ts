/**
 * EmotionAnalyzer — 文本情感分析器。
 *
 * 基于关键词/模式匹配的轻量 VAD 情感分析。
 * 输入文本 + 当前情感状态 → 输出 EmotionTransition。
 *
 * 升级路径：可替换为 LLM-based 情感分析或专用情感模型。
 */

import type { EmotionLabel, EmotionTransition, EmotionTrigger, EmotionVad } from "@ema-agent/core-types"

/** VAD 原型坐标 — 18 个情感标签的标准 VAD 坐标。 */
const EMOTION_PROTOTYPES: Record<EmotionLabel, EmotionVad> = {
  neutral:     { valence: 0.0,  arousal: 0.0,  dominance: 0.0 },
  happy:       { valence: 0.8,  arousal: 0.6,  dominance: 0.4 },
  sad:         { valence: -0.7, arousal: -0.3, dominance: -0.5 },
  angry:       { valence: -0.6, arousal: 0.8,  dominance: 0.7 },
  fearful:     { valence: -0.5, arousal: 0.7,  dominance: -0.6 },
  surprised:   { valence: 0.4,  arousal: 0.9,  dominance: -0.3 },
  disgusted:   { valence: -0.8, arousal: 0.3,  dominance: 0.2 },
  curious:     { valence: 0.3,  arousal: 0.5,  dominance: 0.1 },
  excited:     { valence: 0.9,  arousal: 0.9,  dominance: 0.6 },
  calm:        { valence: 0.5,  arousal: -0.6, dominance: 0.3 },
  anxious:     { valence: -0.3, arousal: 0.7,  dominance: -0.7 },
  confident:   { valence: 0.6,  arousal: 0.3,  dominance: 0.9 },
  shy:         { valence: 0.2,  arousal: 0.1,  dominance: -0.7 },
  bored:       { valence: -0.3, arousal: -0.7, dominance: -0.3 },
  confused:    { valence: -0.1, arousal: 0.4,  dominance: -0.5 },
  loving:      { valence: 0.9,  arousal: 0.2,  dominance: 0.2 },
  playful:     { valence: 0.7,  arousal: 0.5,  dominance: 0.5 },
  serious:     { valence: 0.0,  arousal: 0.1,  dominance: 0.6 },
}

/** 情感关键词 → 情感标签映射。 */
const KEYWORD_PATTERNS: Array<{ regex: RegExp; label: EmotionLabel; weight: number }> = [
  { regex: /(哈哈|嘿嘿|嘻嘻|笑死|好笑|有趣|开心|高兴|快乐|太好了|太棒了|nice|great|awesome|lol|lmao)/i, label: "happy", weight: 0.7 },
  { regex: /(哭|难过|伤心|悲伤|失望|遗憾|可惜|sad|cry|unfortunate)/i, label: "sad", weight: 0.7 },
  { regex: /(生气|愤怒|可恶|讨厌|烦|滚|fuck|damn|angry|annoying)/i, label: "angry", weight: 0.8 },
  { regex: /(害怕|恐怖|可怕|吓|不敢|scary|afraid|fear|horror)/i, label: "fearful", weight: 0.7 },
  { regex: /(哇|天哪|不会吧|竟然|真的假的|什么|surprise|wow|omg|what)/i, label: "surprised", weight: 0.6 },
  { regex: /(恶心|想吐|脏|disgusting|gross|eww)/i, label: "disgusted", weight: 0.8 },
  { regex: /(好奇|想知道|为什么|怎么会|curious|wonder|how come)/i, label: "curious", weight: 0.5 },
  { regex: /(耶|太激动了|兴奋|迫不及待|excited|thrilled|can't wait)/i, label: "excited", weight: 0.7 },
  { regex: /(放松|平静|舒服|安逸|calm|relax|peaceful|chill)/i, label: "calm", weight: 0.5 },
  { regex: /(担心|焦虑|不安|紧张|anxious|nervous|worried|stress)/i, label: "anxious", weight: 0.6 },
  { regex: /(当然|没问题|相信我|包在我身上|confident|sure|certain)/i, label: "confident", weight: 0.5 },
  { regex: /(害羞|不好意思|别这样|shy|embarrassed|blush)/i, label: "shy", weight: 0.6 },
  { regex: /(无聊|没意思|好闷|bored|boring|dull)/i, label: "bored", weight: 0.6 },
  { regex: /(不懂|不明白|混乱|什么情况|confused|puzzled|what's going on)/i, label: "confused", weight: 0.5 },
  { regex: /(爱你|喜欢你|想你了|心疼|love|sweet|darling|honey)/i, label: "loving", weight: 0.7 },
  { regex: /(来玩|捉弄|逗你|playful|teasing|joking)/i, label: "playful", weight: 0.5 },
  { regex: /(认真|严肃|重点|必须|serious|important|critical)/i, label: "serious", weight: 0.5 },
]

/** 情感间的 VAD 距离（欧几里得）。 */
function vadDistance(a: EmotionVad, b: EmotionVad): number {
  const dv = a.valence - b.valence
  const da = a.arousal - b.arousal
  const dd = a.dominance - b.dominance
  return Math.sqrt(dv * dv + da * da + dd * dd)
}

/** 在 VAD 空间中线性插值。 */
function vadLerp(from: EmotionVad, to: EmotionVad, t: number): EmotionVad {
  return {
    valence: from.valence + (to.valence - from.valence) * t,
    arousal: from.arousal + (to.arousal - from.arousal) * t,
    dominance: from.dominance + (to.dominance - from.dominance) * t,
  }
}

/** 从带权匹配中选最佳情感标签。 */
function bestMatch(text: string): { label: EmotionLabel; weight: number } | null {
  let best: { label: EmotionLabel; weight: number } | null = null
  for (const pattern of KEYWORD_PATTERNS) {
    if (pattern.regex.test(text)) {
      if (!best || pattern.weight > best.weight) {
        best = { label: pattern.label, weight: pattern.weight }
      }
    }
  }
  return best
}

/** 估算过渡时长（毫秒）。短过渡适合快速表情切换，长过渡适合情感渐变。 */
function estimateTransitionMs(from: EmotionVad, to: EmotionVad, _weight: number): number {
  const dist = vadDistance(from, to)
  if (dist < 0.3) return 300
  if (dist < 0.7) return 600
  if (dist < 1.2) return 1000
  return 1500
}

/**
 * 分析文本情感，返回从当前情感到新情感的过渡。
 *
 * @param text - 用户输入文本或 Ema 即将回复的文本
 * @param currentEmotion - 当前 VAD 坐标（默认 neutral）
 * @param triggers - 已有的触发源列表（用于追踪）
 * @returns EmotionTransition — 前端用于 Live2D 表情平滑切换
 */
export function analyzeEmotion(
  text: string,
  currentEmotion?: EmotionVad,
  _triggers?: EmotionTrigger[],
): EmotionTransition {
  const from = currentEmotion ?? EMOTION_PROTOTYPES.neutral

  const match = bestMatch(text)
  if (!match) {
    return {
      from,
      to: vadLerp(from, EMOTION_PROTOTYPES.neutral, 0.3),
      transitionMs: 500,
      label: "neutral",
      trigger: {
        source: "user_message",
        reason: "无显著情感关键词，渐归中性",
        weight: 0.1,
      },
    }
  }

  const targetProto = EMOTION_PROTOTYPES[match.label]
  // 按权重混合当前情感与目标原型
  const to = vadLerp(from, targetProto, match.weight)

  const trigger: EmotionTrigger = {
    source: "user_message",
    reason: `检测到情感关键词 → ${match.label} (weight=${match.weight.toFixed(2)})`,
    weight: match.weight,
  }

  return {
    from,
    to,
    transitionMs: estimateTransitionMs(from, to, match.weight),
    label: match.label,
    trigger,
  }
}

/** 获取情感原型坐标（可用于前端情感可视化）。 */
export function getEmotionPrototype(label: EmotionLabel): EmotionVad {
  return { ...EMOTION_PROTOTYPES[label] }
}

/** 获取全部 18 个情感原型。 */
export function getAllEmotionPrototypes(): Record<EmotionLabel, EmotionVad> {
  return { ...EMOTION_PROTOTYPES }
}
