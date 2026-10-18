import type { Profile } from 'wlipsync';
import processorUrl from 'wlipsync/audio-processor.js?url';
import wasmUrl from 'wlipsync/wlipsync.wasm?url';
import profileJson from './wLipSyncProfile.json';

// 舞台接收的是单一 mouthOpen, 因此只取 A/E/I/O/U 的置信度计算开口度.
// S 不作为元音使用, 闭嘴过渡交给后面的平滑计算.
const VOWEL_KEYS = ['A', 'E', 'I', 'O', 'U'] as const;

// 音量软化曲线保留轻声开口, 同时由元音置信度过滤纯噪声和停顿, 避免由外部噪音导致的嘴型抖动
const VOLUME_SCALE = 0.9;
const VOLUME_EXPONENT = 0.7;
// TODO: 核对 40ms 重新计算与播放端约 33ms 发布的组合是否造成可见口型停顿.
const MOUTH_UPDATE_INTERVAL_MS = 40;
const MOUTH_LERP_WINDOW_MS = 120;

let wasmModulePromise: Promise<WebAssembly.Module> | null = null;

export interface EmaLipSync {
  /** 把音频源接入 wLipSync worklet(只分析, 不改变原播放链路) */
  connectSource(source: AudioNode): void;
  /** 当前嘴张开度 0..1(已节流 + 平滑) */
  getMouthOpen(): number;
  /** 断开 worklet */
  dispose(): void;
}

/** 加载口型分析节点; 加载失败时由播放模块改用音量变化驱动口型. */
export async function createEmaLipSync(audioContext: AudioContext): Promise<EmaLipSync> {
  // 单文件入口的 new URL(data:..., import.meta.url) 会被 Vite 改成不存在的文件路径.
  // 使用包内独立资源, 由 Vite 生成开发地址和正式包地址, 不依赖 data: 脚本.
  // WASM 编译结果可以跨 AudioContext 复用, Worklet 脚本仍须注册到当前 Context.
  wasmModulePromise ??= WebAssembly.compileStreaming(fetch(wasmUrl));
  const [{ WLipSyncAudioNode }, wasmModule] = await Promise.all([
    // 包的顶层引用 AudioWorkletNode, 只在浏览器使用时加载, 避免 Node 测试直接执行.
    import('wlipsync/wlipsync.js'),
    wasmModulePromise,
    audioContext.audioWorklet.addModule(processorUrl),
  ]);
  const node = new WLipSyncAudioNode(audioContext, profileJson as unknown as Profile, wasmModule);

  const now = (): number => (typeof performance !== 'undefined' ? performance.now() : Date.now());

  let lastRawMouthOpen = 0;
  let lastRawUpdateMs = 0;
  let smoothedMouthOpen = 0;
  let lastSmoothedMs = 0;

  // 取当前最可信的元音, 再乘音量, 转成舞台接收的 0..1 开口度.
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
