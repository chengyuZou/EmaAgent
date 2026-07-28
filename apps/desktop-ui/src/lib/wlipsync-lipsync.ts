// 基于 wLipSync 的 Live2D 唇同步：MFCC 元音识别替代 RMS 音量包络，聚合为单一 mouthOpen
import type { Profile } from 'wlipsync';
import profileJson from './wlipsync-profile.json';

// wLipSync 原始输出为 A/E/I/O/U/S 六个权重。
// Ema 模型没有各元音嘴型参数（cdi3.json 只有 ParamMouthOpenY + ParamMouthForm，
// 没有 ParamMouthA/E/I/O/U），因此元音识别结果无法驱动分元音嘴型，
// 只能聚合为单一 mouthOpen（取最大元音权重）；相比 RMS 音量包络，
// 元音识别抗噪、对浊音/清音的幅度判断更准确。
const RAW_KEYS = ['A', 'E', 'I', 'O', 'U', 'S'] as const;
const RAW_TO_VOWEL: Record<(typeof RAW_KEYS)[number], 'A' | 'E' | 'I' | 'O' | 'U'> = {
  A: 'A',
  E: 'E',
  I: 'I',
  O: 'O',
  U: 'U',
  // S（无声/咝音）折到 I，避免闭嘴瞬间硬跳
  S: 'I',
};

// 音量软化曲线：amp = min(volume × 0.9, 1) ^ 0.7，再按元音权重封顶 0.7
const VOWEL_CAP = 0.7;
const VOLUME_SCALE = 0.9;
const VOLUME_EXPONENT = 0.7;
// mouthOpen 重算节流（约 25fps，防抖）与 lerp 平滑窗口
const MOUTH_UPDATE_INTERVAL_MS = 40;
const MOUTH_LERP_WINDOW_MS = 120;

export interface EmaLipSync {
  /** 把音频源接入 wLipSync worklet（只分析，不改变原播放链路） */
  connectSource(source: AudioNode): void;
  /** 当前嘴张开度 0..1（已节流 + 平滑） */
  getMouthOpen(): number;
  /** 断开 worklet */
  dispose(): void;
}

/**
 * 创建基于 wLipSync 的唇同步 helper。
 *
 * 运行时注意：wlipsync 默认导出为单文件构建，WASM 与 AudioWorklet processor
 * 均内联为 data: URL，不依赖额外资源路径；但 Tauri CSP 若禁止
 * data: 的 script/worker/worklet 加载（audioWorklet.addModule / WebAssembly
 * instantiateStreaming），运行时仍会失败。此处只做 typecheck 层集成，
 * 运行时 WASM 加载失败时由调用方 fallback 到 RMS 音量包络（tts-playback.ts）。
 */
export async function createEmaLipSync(audioContext: AudioContext): Promise<EmaLipSync> {
  // wlipsync 顶层引用 AudioWorkletNode(浏览器 API),Node/vitest/SSR 环境会
  // ReferenceError。改为懒加载:仅在浏览器真正创建唇同步时才 import。
  const { createWLipSyncNode } = await import('wlipsync');
  const node = await createWLipSyncNode(audioContext, profileJson as unknown as Profile);

  const now = (): number => (typeof performance !== 'undefined' ? performance.now() : Date.now());

  let lastRawMouthOpen = 0;
  let lastRawUpdateMs = 0;
  let smoothedMouthOpen = 0;
  let lastSmoothedMs = 0;

  // 元音权重 × 音量软化系数，S 折入 I 后取最大
  const computeMouthOpen = (): number => {
    const amp = Math.min((node.volume ?? 0) * VOLUME_SCALE, 1) ** VOLUME_EXPONENT;
    let maxWeight = 0;
    const projected: Record<'A' | 'E' | 'I' | 'O' | 'U', number> = { A: 0, E: 0, I: 0, O: 0, U: 0 };
    for (const raw of RAW_KEYS) {
      const vowel = RAW_TO_VOWEL[raw];
      const rawVal = node.weights?.[raw] ?? 0;
      projected[vowel] = Math.max(projected[vowel], Math.min(VOWEL_CAP, rawVal * amp));
    }
    for (const w of Object.values(projected)) {
      maxWeight = Math.max(maxWeight, w);
    }
    return maxWeight;
  };

  const getMouthOpen = (): number => {
    const timestamp = now();
    if (lastRawUpdateMs === 0 || timestamp - lastRawUpdateMs >= MOUTH_UPDATE_INTERVAL_MS) {
      lastRawMouthOpen = computeMouthOpen();
      lastRawUpdateMs = timestamp;
    }
    if (lastSmoothedMs === 0) {
      smoothedMouthOpen = lastRawMouthOpen;
      lastSmoothedMs = timestamp;
      return smoothedMouthOpen;
    }
    const alpha = Math.min(1, (timestamp - lastSmoothedMs) / MOUTH_LERP_WINDOW_MS);
    smoothedMouthOpen += (lastRawMouthOpen - smoothedMouthOpen) * alpha;
    lastSmoothedMs = timestamp;
    return smoothedMouthOpen;
  };

  return {
    connectSource(source: AudioNode): void {
      try {
        source.connect(node);
      } catch (error) {
        console.error('[wlipsync-lipsync] 连接音频源到唇同步节点失败', error);
      }
    },
    getMouthOpen,
    dispose(): void {
      try {
        node.disconnect();
      } catch { /* 已断开 */ }
    },
  };
}
