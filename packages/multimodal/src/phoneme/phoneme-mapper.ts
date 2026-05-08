/**
 * PhonemeMapper — 文本→口型时间线映射器。
 *
 * 将文本分解为音素序列并估算时间线，用于驱动 Live2D 口型同步。
 * V1 使用启发式规则（字符→音素映射 + 时长估算），
 * 升级路径可接入 TTS 引擎的 SSML <phoneme> 输出或专用音素预测模型。
 */

import type { PhonemeSymbol, PhonemeTimeline, PhonemeTiming, VoiceProfile } from "@ema-agent/core-types"

/** 中文字符到 Live2D 日语音素的近似映射。 */
const CN_PHONEME_MAP: Record<string, PhonemeSymbol> = {
  // 单元音韵母
  a: "A", ā: "A", á: "A", ǎ: "A", à: "A",
  o: "O", ō: "O", ó: "O", ǒ: "O", ò: "O",
  e: "E", ē: "E", é: "E", ě: "E", è: "E",
  i: "I", ī: "I", í: "I", ǐ: "I", ì: "I",
  u: "U", ū: "U", ú: "U", ǔ: "U", ù: "U",
  ü: "U", ǖ: "U", ǘ: "U", ǚ: "U", ǜ: "U",

  // 复合韵母（取主要元音）
  ai: "A", ei: "E", ao: "A", ou: "O",
  ia: "I", ie: "E", ua: "U", uo: "O", üe: "E",
  iao: "I", iu: "U", uai: "U", ui: "U",
  an: "A", en: "N", ang: "A", eng: "N", ong: "O",
  ian: "I", in: "N", iang: "I", ing: "N", iong: "O",
  uan: "U", un: "N", uang: "U", ueng: "N",
}

/** 声母（辅音）到音素的映射。 */
const CN_CONSONANT_MAP: Record<string, PhonemeSymbol> = {
  b: "B", p: "P", m: "M", f: "F",
  d: "T", t: "T", n: "N", l: "R",
  g: "K", k: "K", h: "K",
  j: "CH", q: "CH", x: "SH",
  zh: "JH", ch: "CH", sh: "SH", r: "R",
  z: "S", c: "S", s: "S",
  y: "Y", w: "W",
}

/** 英文 ARPABET → Live2D 音素映射。 */
const EN_PHONEME_MAP: Record<string, PhonemeSymbol> = {
  AA: "AA", AE: "AE", AH: "AH", AO: "AO", AW: "AW", AY: "AY",
  EH: "EH", ER: "ER", EY: "EY", IH: "IH", IY: "IY",
  OW: "OW", OY: "OY", UH: "UH", UW: "UW",
  W: "W", Y: "Y",
  B: "B", CH: "CH", D: "T", DH: "DH", F: "F", G: "K",
  HH: "K", JH: "JH", K: "K", L: "R", M: "M", N: "N",
  NG: "N", P: "P", R: "R", S: "S", SH: "SH", T: "T",
  TH: "TH", V: "F", Z: "S", ZH: "ZH",
}

/** 标点 → 静音时长（毫秒）。 */
const PAUSE_MAP: Record<string, number> = {
  "。": 400, ".": 400, "！": 300, "!": 300, "？": 300, "?": 300,
  "；": 200, ";": 200, "：": 200, ":": 200, "，": 150, ",": 150,
  "…": 400, "——": 300, "\n": 300,
}

/** 中文每个音节的估算时长（毫秒）。 */
const CN_SYLLABLE_MS = 200
/** 英文每个音素的估算时长（毫秒）。 */
const EN_PHONEME_MS = 120

/** 检测文本是否主要为英文。 */
function isEnglish(text: string): boolean {
  const alpha = text.replace(/[^a-zA-Z]/g, "")
  const cjk = text.replace(/[^一-鿿]/g, "")
  return alpha.length > cjk.length
}

/** 中文文本 → 音素序列（拼音近似）。 */
function chineseToPhonemes(text: string): Array<{ phoneme: PhonemeSymbol; durationMs: number; isPause: boolean }> {
  const result: Array<{ phoneme: PhonemeSymbol; durationMs: number; isPause: boolean }> = []

  let i = 0
  while (i < text.length) {
    const ch = text[i]!

    // 跳过空白
    if (ch === " " || ch === "\t") {
      i++
      continue
    }

    // 标点 → 静音
    const twoChar = text.slice(i, i + 2)
    if (PAUSE_MAP[twoChar]) {
      result.push({ phoneme: "SIL", durationMs: PAUSE_MAP[twoChar]!, isPause: true })
      i += 2
      continue
    }
    if (PAUSE_MAP[ch]) {
      result.push({ phoneme: "SIL", durationMs: PAUSE_MAP[ch]!, isPause: true })
      i++
      continue
    }

    // 尝试匹配双字符声母（zh/ch/sh）
    if (i + 1 < text.length) {
      const pair = text.slice(i, i + 2)
      if (CN_CONSONANT_MAP[pair]) {
        result.push({ phoneme: CN_CONSONANT_MAP[pair]!, durationMs: CN_SYLLABLE_MS * 0.4, isPause: false })
        i += 2
        continue
      }
    }

    // 单字符匹配
    if (CN_CONSONANT_MAP[ch]) {
      result.push({ phoneme: CN_CONSONANT_MAP[ch]!, durationMs: CN_SYLLABLE_MS * 0.4, isPause: false })
    } else if (CN_PHONEME_MAP[ch]) {
      result.push({ phoneme: CN_PHONEME_MAP[ch]!, durationMs: CN_SYLLABLE_MS * 0.6, isPause: false })
    } else if (/[一-鿿]/.test(ch)) {
      // 未知汉字默认开口 A
      result.push({ phoneme: "A", durationMs: CN_SYLLABLE_MS, isPause: false })
    } else {
      // 非中文非标点字符，按英文音素近似
      result.push({ phoneme: "AH", durationMs: EN_PHONEME_MS, isPause: false })
    }
    i++
  }

  return result
}

/** 英文文本 → 音素序列（极简映射，真实场景需接入 CMUdict 或 TTS phoneme API）。 */
function englishToPhonemes(text: string): Array<{ phoneme: PhonemeSymbol; durationMs: number; isPause: boolean }> {
  const result: Array<{ phoneme: PhonemeSymbol; durationMs: number; isPause: boolean }> = []
  const words = text.split(/\s+/)

  for (const word of words) {
    if (!word) continue

    const upper = word.toUpperCase().replace(/[^A-Z]/g, "")
    if (!upper) continue

    // 尝试匹配 ARPABET（单/双字母）
    let i = 0
    while (i < upper.length) {
      if (i + 1 < upper.length) {
        const pair = upper.slice(i, i + 2)
        if (EN_PHONEME_MAP[pair]) {
          result.push({ phoneme: EN_PHONEME_MAP[pair]!, durationMs: EN_PHONEME_MS, isPause: false })
          i += 2
          continue
        }
      }
      const single = upper[i]!
      result.push({ phoneme: EN_PHONEME_MAP[single] ?? "AH", durationMs: EN_PHONEME_MS, isPause: false })
      i++
    }

    // 词间短暂停顿
    result.push({ phoneme: "SIL", durationMs: 80, isPause: true })
  }

  return result
}

/**
 * 根据文本和语音配置构建口型时间线。
 *
 * 启发式方法：将文本拆分为音素序列，按每个音素的估算时长累加时间戳。
 * V2 可替换为 TTS 引擎返回的真实 phoneme timing 或 espeak-ng/MaryTTS 输出。
 *
 * @param text - 需要合成口型的文本
 * @param voice - 目标语音配置（影响音素时长估算的倍率）
 * @returns PhonemeTimeline — 音素序列 + 总时长 + 数据来源标记
 */
export function buildPhonemeTimeline(text: string, voice: VoiceProfile): PhonemeTimeline {
  const speedMultiplier = 1 / (voice.speed ?? 1.0)
  const phonemeEntries = isEnglish(text)
    ? englishToPhonemes(text)
    : chineseToPhonemes(text)

  let currentMs = 0
  const phonemes: PhonemeTiming[] = []

  for (const entry of phonemeEntries) {
    const durationMs = Math.round(entry.durationMs * speedMultiplier)
    phonemes.push({
      phoneme: entry.phoneme,
      startMs: currentMs,
      endMs: currentMs + durationMs,
    })
    currentMs += durationMs
  }

  return {
    phonemes,
    totalDurationMs: currentMs,
    source: "estimated",
  }
}
