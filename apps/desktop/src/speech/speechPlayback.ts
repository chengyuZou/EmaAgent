import type { AudioSegment, CharacterTag, SpeechAudioIdentity, SpeechGenerationEvent, AudioPlayback } from '@ema-agent/speech';
import { audioApi } from '../api/audio.js';
import { tauriBridge } from '../lib/tauri/tauriBridge.js';
import { showToast } from '../lib/notifications/toast.js';
import { createEmaLipSync, type EmaLipSync } from './wLipSync.js';

/** AudioPlayback Store 提供这些回调, 本文件在播放进度或媒体状态变化时调用. */
export interface SpeechPlaybackCallbacks {
  /** loading 包含等待声音和缓冲, playing 来自音频元素真正开始播放的事件. */
  onStatus(status: 'loading' | 'playing'): void;
  /** 播放位置进入另一文字段时交付整句, 不随 LLM 增量逐次交付. */
  onCaption(segment: AudioSegment): void;
  /** false 保留当前句并暂停显字动画, true 让同一句的动画继续. */
  onCaptionPlaying(isPlaying: boolean): void;
  /** 首次自动播放到达标签位置时交付, 历史重播不执行表情和动作. */
  onTags(tags: readonly CharacterTag[]): void;
  /** 当前播放器收尾后通知 Store 清理展示, 不把 TTS 生成完成当作声音已播完. */
  onEnded(): void;
}

interface SpeechPlayer {
  readonly identity: SpeechAudioIdentity;
  readonly sourceKind: 'automatic' | 'saved';
  readonly audio: HTMLAudioElement;
  readonly mediaListeners: AbortController;
  readonly callbacks: SpeechPlaybackCallbacks;
  readonly segments: AudioSegment[];
  source: MediaElementAudioSourceNode | null;
  hasRequestedUrl: boolean;
  playbackStatus: 'loading' | 'playing';
  /** null 表示尚未交付字幕, syncPlayback 在交付新的段号时更新. */
  lastCaptionSegmentIndex: number | null;
  /** 已处理的段前缀, 包含没有标签的普通段, 防止结束时间更新或重复通知重放标签. */
  nextTagSegmentIndex: number;
}

// 当前播放器唯一持有音频对象和整份段表. Store 只接收可显示的状态和当前字幕.
let currentPlayer: SpeechPlayer | null = null;
let audioContext: AudioContext | null = null;
let analyser: AnalyserNode | null = null;
let fallbackVolumeData: Uint8Array<ArrayBuffer> | null = null;
let lipSync: EmaLipSync | null = null;
let lipSyncPromise: Promise<EmaLipSync | null> | null = null;
let mouthTrackingFrame: number | null = null;
let lastLipSyncPublish = 0;

function audioGraph(): { context: AudioContext; analyser: AnalyserNode } {
  if (!audioContext) {
    audioContext = new AudioContext();
    analyser = audioContext.createAnalyser();
    analyser.fftSize = 256;
    analyser.smoothingTimeConstant = 0.4;
    analyser.connect(audioContext.destination);
    fallbackVolumeData = new Uint8Array(analyser.frequencyBinCount);
  }
  return { context: audioContext, analyser: analyser! };
}

async function ensureLipSync(): Promise<EmaLipSync | null> {
  if (lipSync) return lipSync;
  const preparingContext = audioGraph().context;
  lipSyncPromise ??= createEmaLipSync(preparingContext)
    .then(value => {
      if (audioContext !== preparingContext) {
        value.dispose();
        return null;
      }
      lipSync = value;
      return value;
    })
    .catch(error => {
      console.error('[tts-playback] wLipSync 初始化失败, 改用音量变化驱动口型', error);
      return null;
    });
  return lipSyncPromise;
}

function connectLipSync(player: SpeechPlayer, source: MediaElementAudioSourceNode): void {
  void ensureLipSync().then(value => {
    // Worklet 可能晚于停止或换 Turn 才加载完成, 不能重新接回已经断开的音源.
    if (currentPlayer === player && player.source === source) value?.connectSource(source);
  });
}

function publishLipSync(speaking: boolean, mouthOpen: number, force = false): void {
  const now = performance.now();
  if (!force && now - lastLipSyncPublish < 33) return;
  lastLipSyncPublish = now;
  void tauriBridge.publishStageLipSync(speaking, mouthOpen);
}

function startMouthTracking(): void {
  if (mouthTrackingFrame !== null) return;
  publishLipSync(true, 0, true);
  const frame = (): void => {
    let mouthOpen = lipSync?.getMouthOpen();
    if (mouthOpen === undefined) {
      const output = audioGraph().analyser;
      output.getByteTimeDomainData(fallbackVolumeData!);
      let sum = 0;
      for (const sample of fallbackVolumeData!) {
        const value = (sample - 128) / 128;
        sum += value * value;
      }
      mouthOpen = Math.min(1, Math.sqrt(sum / fallbackVolumeData!.length) * 3);
    }
    publishLipSync(true, mouthOpen);
    mouthTrackingFrame = requestAnimationFrame(frame);
  };
  frame();
}

function stopMouthTracking(): void {
  if (mouthTrackingFrame !== null) cancelAnimationFrame(mouthTrackingFrame);
  mouthTrackingFrame = null;
  publishLipSync(false, 0, true);
}


function syncPlayback(player: SpeechPlayer): void {
  if (currentPlayer !== player || player.playbackStatus !== 'playing') return;
  // 用实际播放位置对照段表的 startMs/endMs, 按毫秒比较; 文本或声音生成得更快不会提前换句.
  const playedMs = player.audio.currentTime * 1000;
  // endMs 未确定或尚未播到段末时, 保留该段标签, 等后续进度检查再处理.
  while (player.segments[player.nextTagSegmentIndex]) {
    const segment = player.segments[player.nextTagSegmentIndex]!;
    if (segment.endMs === null || segment.endMs > playedMs) break;
    player.nextTagSegmentIndex++;
    if (player.sourceKind === 'automatic' && segment.tags) player.callbacks.onTags(segment.tags);
  }
  let caption: AudioSegment | undefined;
  // 选择已经到达起点且尚未结束的文字段. 纯标签项没有字幕, endMs 为 null 时暂不判断段末.
  for (const segment of player.segments) {
    if (!segment) continue;
    if (segment.startMs > playedMs) break;
    if (segment.textForTTS && (segment.endMs === null || playedMs < segment.endMs)) caption = segment;
  }
  // 同一段的进度变化不重发整句, 避免每次 timeupdate 都更新字幕 State 并跨窗口广播.
  if (caption && caption.segmentIndex !== player.lastCaptionSegmentIndex) {
    player.lastCaptionSegmentIndex = caption.segmentIndex;
    player.callbacks.onCaption(caption);
  }
}

function disposePlayer(player: SpeechPlayer): void {
  if (currentPlayer !== player) return;
  // 先撤掉当前身份和监听, 旧 play() 的拒绝和媒体事件不能清除后一次播放.
  currentPlayer = null;
  player.mediaListeners.abort();
  player.audio.pause();
  player.audio.removeAttribute('src');
  player.audio.load();
  player.source?.disconnect();
  stopMouthTracking();
}

function finishPlayer(player: SpeechPlayer): void {
  if (currentPlayer !== player) return;
  syncPlayback(player);
  disposePlayer(player);
  player.callbacks.onEnded();
}

function createPlayer(identity: SpeechAudioIdentity, sourceKind: SpeechPlayer['sourceKind'], callbacks: SpeechPlaybackCallbacks): SpeechPlayer {
  if (currentPlayer) disposePlayer(currentPlayer);
  const audio = new Audio();
  // 地址赋值前启用 CORS, 否则跨源音频接入 Web Audio 后会静音, 口型也没有采样.
  audio.crossOrigin = 'anonymous';
  audio.preload = 'auto';
  const player: SpeechPlayer = {
    identity, sourceKind, callbacks, audio, mediaListeners: new AbortController(),
    segments: [], source: null, hasRequestedUrl: false, playbackStatus: 'loading',
    lastCaptionSegmentIndex: null, nextTagSegmentIndex: 0,
  };
  currentPlayer = player;
  callbacks.onStatus('loading');
  const signal = player.mediaListeners.signal;
  audio.addEventListener('playing', () => {
    if (currentPlayer !== player) return;
    player.playbackStatus = 'playing';
    callbacks.onStatus('playing');
    // 缓冲后恢复时沿用当前字幕, 只让暂停的显字动画继续.
    callbacks.onCaptionPlaying(true);
    startMouthTracking();
    syncPlayback(player);
  }, { signal });
  audio.addEventListener('waiting', () => {
    if (currentPlayer !== player) return;
    // 先处理刚播到段末的标签, 再暂停字幕动画和口型.
    syncPlayback(player);
    player.playbackStatus = 'loading';
    callbacks.onStatus('loading');
    // 声音等待数据时保留当前句并暂停显字, 避免文字独自继续显示.
    callbacks.onCaptionPlaying(false);
    stopMouthTracking();
  }, { signal });
  // 进度检查由浏览器媒体事件驱动, 没有固定间隔的轮询或毫秒级误差保证.
  audio.addEventListener('timeupdate', () => syncPlayback(player), { signal });
  audio.addEventListener('ended', () => {
    player.playbackStatus = 'playing';
    finishPlayer(player);
  }, { signal });
  audio.addEventListener('error', () => {
    if (currentPlayer !== player) return;
    finishPlayer(player);
    showToast('语音播放失败, 请检查音频文件和本地服务', { variant: 'warning' });
  }, { signal });
  return player;
}

async function playUrl(player: SpeechPlayer): Promise<void> {
  if (currentPlayer !== player || player.hasRequestedUrl) return;
  player.hasRequestedUrl = true;
  try {
    const { context, analyser: output } = audioGraph();
    if (context.state === 'suspended') await context.resume();
    const url = await audioApi.audioUrl(player.identity.audioId);
    if (currentPlayer !== player) return;
    const source = context.createMediaElementSource(player.audio);
    player.source = source;
    source.connect(output);
    connectLipSync(player, source);
    // 只设置文件地址, 声音由浏览器边读边解码, 不下载完整 Blob 或 AudioBuffer.
    player.audio.src = url;
    await player.audio.play();
  } catch (error) {
    if (currentPlayer !== player) return;
    finishPlayer(player);
    showToast(error instanceof Error ? error.message : '无法开始播放语音', { variant: 'warning' });
  }
}

function mergeSegments(player: SpeechPlayer, updates: readonly AudioSegment[]): void {
  for (const segment of updates) {
    const previous = player.segments[segment.segmentIndex];
    // 保留已确定的结束时间, 仍接受同一段的新资料; 标签项按流内段号只处理一次.
    player.segments[segment.segmentIndex] = previous?.endMs !== null && previous?.endMs !== undefined && segment.endMs === null
      ? { ...segment, endMs: previous.endMs }
      : segment;
  }
}

export function startAutomaticPlayback(identity: SpeechAudioIdentity, callbacks: SpeechPlaybackCallbacks): void {
  createPlayer(identity, 'automatic', callbacks);
}

export function startSavedPlayback(playback: AudioPlayback, callbacks: SpeechPlaybackCallbacks): void {
  const player = createPlayer(playback, 'saved', callbacks);
  mergeSegments(player, playback.segments);
  void playUrl(player);
}

export function receiveSpeechEvent(event: SpeechGenerationEvent): void {
  const player = currentPlayer;
  if (!player || player.sourceKind !== 'automatic' || player.identity.audioId !== event.audioId) return;
  if (event.type === 'speech_segments') {
    mergeSegments(player, event.segments);
    // AudioID 分配时文件尚不存在, 至少有一段实际声音后才请求 WAV.
    if (player.segments.some(segment => segment?.textForTTS)) void playUrl(player);
    // 开头的纯标签项位于 0 ms, 没有前文需要等待, 不必为它读取空音频.
    while (player.segments[player.nextTagSegmentIndex]?.textForTTS === null
      && player.segments[player.nextTagSegmentIndex]?.endMs === 0) {
      const segment = player.segments[player.nextTagSegmentIndex++]!;
      if (segment.tags) player.callbacks.onTags(segment.tags);
    }
    syncPlayback(player);
  } else if (event.type === 'speech_generate_completed') {
    if (event.audioAvailable) void playUrl(player);
    else {
      // 只有标签的回复没有音频文件, 按流顺序执行, 不发起空文件读取.
      for (const segment of player.segments) {
        if (segment?.tags && segment.segmentIndex >= player.nextTagSegmentIndex) {
          player.callbacks.onTags(segment.tags);
          player.nextTagSegmentIndex = segment.segmentIndex + 1;
        }
      }
      finishPlayer(player);
    }
  } else if (event.type === 'speech_generate_cancelled' || event.type === 'speech_generate_failed'
    || event.type === 'speech_generate_unavailable') {
    finishPlayer(player);
  }
}

export function stopPlayback(): void {
  if (currentPlayer) disposePlayer(currentPlayer);
}

/** 只在主窗口真正卸载时调用, 切换 Chat 和 Settings 不关闭音频图. */
export function closeSpeechPlayback(): void {
  stopPlayback();
  lipSync?.dispose();
  lipSync = null;
  lipSyncPromise = null;
  const closingContext = audioContext;
  audioContext = null;
  analyser = null;
  fallbackVolumeData = null;
  if (closingContext) void closingContext.close().catch(() => undefined);
}
