// 基于 wLipSync 的 Live2D 唇同步: MFCC 元音识别替代 RMS 音量包络, 聚合为单一 mouthOpen
import type { Profile } from 'wlipsync';
import profileJson from './wlipsync-profile.json';

// wLipSync 原始输出为 A/E/I/O/U/S 六个权重
// Live2D 模型没有各元音嘴型参数(cdi3.json 只有 ParamMouthOpenY + ParamMouthForm 没有 ParamMouthA/E/I/O/U)
// 因此元音识别结果无法驱动分元音嘴型
// 这里只把五个元音置信度聚合为单一 mouthOpen S 不代表元音,闭嘴过渡交给平滑处理.
const VOWEL_KEYS = ['A', 'E', 'I', 'O', 'U'] as const;

// 音量软化曲线保留轻声开口, 同时由元音置信度过滤纯噪声和停顿, 避免由外部噪音导致的嘴型抖动
const VOLUME_SCALE = 0.9;
const VOLUME_EXPONENT = 0.7;
// mouthOpen 重算节流(约 25fps, 防抖)与 lerp 平滑窗口
// TODO: 频率注意一下嘴巴状态往 Stage 发布 30 FPS 错位
const MOUTH_UPDATE_INTERVAL_MS = 40;
const MOUTH_LERP_WINDOW_MS = 120;

export interface EmaLipSync {
  /** 把音频源接入 wLipSync worklet(只分析, 不改变原播放链路) */
  connectSource(source: AudioNode): void;
  /** 当前嘴张开度 0..1(已节流 + 平滑) */
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
 * WASM 加载失败时, Chat 语音播放会改用 RMS 音量包络驱动口型.
 */
export async function createEmaLipSync(audioContext: AudioContext): Promise<EmaLipSync> {
  // wlipsync 顶层引用 AudioWorkletNode(浏览器 API),Node/vitest/SSR 环境会ReferenceError
  // 改为懒加载:仅在浏览器真正创建唇同步时才 import.
  const { createWLipSyncNode } = await import('wlipsync');
  const node = await createWLipSyncNode(audioContext, profileJson as unknown as Profile);

  const now = (): number => (typeof performance !== 'undefined' ? performance.now() : Date.now());

  let lastRawMouthOpen = 0;
  let lastRawUpdateMs = 0;
  let smoothedMouthOpen = 0;
  let lastSmoothedMs = 0;

  // 模型只有一个张嘴参数, 因此取当前最可信的元音, 再乘音量得到统一开口度.
  const computeMouthOpen = (): number => {
    const amp = Math.min((node.volume ?? 0) * VOLUME_SCALE, 1) ** VOLUME_EXPONENT;
    let maxWeight = 0;
    for (const vowel of VOWEL_KEYS) {
      maxWeight = Math.max(maxWeight, node.weights?.[vowel] ?? 0);
    }
    return Math.min(1, Math.max(0, maxWeight * amp));
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
