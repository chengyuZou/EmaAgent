import type { SpeechGenerateEvent } from '@ema-agent/server/routes/ws/speech.js';
import { turnsApi } from '../../api/turns.js';
import { tauriBridge } from '../../lib/tauriBridge.js';
import { showToast } from '../../lib/notifications/toast.js';
import { createEmaLipSync, type EmaLipSync } from './wLipSync.js';
import { sessionPresentation, usePlaybackStore, type PlaybackStatus } from '../presentation/sessionPresentation.js';
import { subscribeSpeechGeneration, useSpeechGenerationStore } from './turnSpeechGeneration.js';
export { usePlaybackStore } from '../presentation/sessionPresentation.js';
export type { PlaybackStatus } from '../presentation/sessionPresentation.js';

interface SpeechPlayer {
  readonly sessionId: string;
  readonly turnId: string;
  readonly followsGeneration: boolean;
  readonly audio: HTMLAudioElement;
  readonly mediaListeners: AbortController;
  source: MediaElementAudioSourceNode | null;
  urlRequested: boolean;
}

let currentPlayer: SpeechPlayer | null = null;
let audioContext: AudioContext | null = null;
let analyser: AnalyserNode | null = null;
let fallbackVolumeData: Uint8Array<ArrayBuffer> | null = null;
let lipSync: EmaLipSync | null = null;
let lipSyncPromise: Promise<EmaLipSync | null> | null = null;
let mouthTrackingFrame = 0;
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
  lipSyncPromise ??= createEmaLipSync(audioGraph().context)
    .then(value => {
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
  if (mouthTrackingFrame) return;
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
  if (mouthTrackingFrame) cancelAnimationFrame(mouthTrackingFrame);
  mouthTrackingFrame = 0;
  publishLipSync(false, 0, true);
}

function setPlaybackStatus(player: SpeechPlayer, status: PlaybackStatus): void {
  sessionPresentation.setPlaybackStatus(player.sessionId, player.turnId, status);
}

function createPlayer(sessionId: string, turnId: string, followsGeneration: boolean): SpeechPlayer {
  const audio = new Audio();
  // 音频走 loopback Server, 与 WebView 页面不同源. 必须先设置 CORS 再赋 src,
  // 否则 MediaElementAudioSourceNode 会播放静音, 口型分析也拿不到采样.
  audio.crossOrigin = 'anonymous';
  audio.preload = 'auto';
  const player: SpeechPlayer = {
    sessionId,
    turnId,
    followsGeneration,
    audio,
    mediaListeners: new AbortController(),
    source: null,
    urlRequested: false,
  };
  currentPlayer = player;
  setPlaybackStatus(player, 'loading');

  const signal = player.mediaListeners.signal;
  audio.addEventListener('playing', () => {
    if (currentPlayer !== player) return;
    setPlaybackStatus(player, 'playing');
    startMouthTracking();
  }, { signal });
  audio.addEventListener('waiting', () => {
    if (currentPlayer !== player) return;
    setPlaybackStatus(player, 'loading');
    stopMouthTracking();
  }, { signal });
  audio.addEventListener('ended', () => finishPlayer(player), { signal });
  audio.addEventListener('error', () => failPlayer(player, mediaErrorMessage(audio.error)), { signal });
  return player;
}

export function startTurnSpeechPlayback(sessionId: string, turnId: string): void {
  if (sessionPresentation.enqueueSpeech(sessionId, turnId)) startPendingSpeechPlayback();
}

/** 首项在上一段媒体实际结束后才建立 Audio; 待播项不预下载整轮文件. */
export function startPendingSpeechPlayback(): void {
  const state = usePlaybackStore.getState();
  const key = state.queue[0];
  if (currentPlayer || !key || state.playbackStatus === null) return;
  const generation = useSpeechGenerationStore.getState().active.get(key.turnId);
  const player = createPlayer(key.sessionId, key.turnId, generation !== undefined);
  if (!generation || generation.audioReady) void playUrl(player);
}

subscribeSpeechGeneration(event => {
  const player = currentPlayer;
  if (!player || player.sessionId !== event.sessionId || player.turnId !== event.turnId) {
    if (event.type === 'speech_generate_cancelled' || event.type === 'speech_generate_failed'
      || event.type === 'speech_generate_unavailable'
      || (event.type === 'speech_generate_completed' && !event.audioAvailable)) {
      sessionPresentation.removePendingTurn(event.sessionId, event.turnId);
    }
    return;
  }
  if (player.followsGeneration) receiveSpeechControl(player, event);
});

function receiveSpeechControl(player: SpeechPlayer, event: SpeechGenerateEvent): void {
  switch (event.type) {
    case 'speech_generate_started':
      void playUrl(player);
      return;
    case 'speech_generate_warning':
      return;
    case 'speech_generate_completed':
      // Server 已写完文件, 不代表浏览器已播完. HTTP 读到文件尾后由 audio 的 ended 释放 owner.
      if (event.audioAvailable) void playUrl(player);
      else finishPlayer(player);
      return;
    case 'speech_generate_cancelled':
      finishPlayer(player);
      return;
    case 'speech_generate_failed':
      finishPlayer(player);
      return;
    case 'speech_generate_unavailable':
      failPlayer(player, '该轮没有可播放的语音');
      return;
  }
}

async function playUrl(player: SpeechPlayer): Promise<void> {
  if (currentPlayer !== player || player.urlRequested) return;
  player.urlRequested = true;
  try {
    const { context, analyser: output } = audioGraph();
    if (context.state === 'suspended') await context.resume();
    const url = await turnsApi.audioUrl(player.turnId);
    if (currentPlayer !== player) return;

    const source = context.createMediaElementSource(player.audio);
    player.source = source;
    source.connect(output);
    connectLipSync(player, source);
    // 浏览器边读取 URL 边解码播放; 不先 fetch 整轮文件, 也不保存整轮 AudioBuffer.
    player.audio.src = url;
    await player.audio.play();
  } catch (error) {
    failPlayer(player, error instanceof Error ? error.message : '语音播放失败');
  }
}

function disposePlayer(player: SpeechPlayer): void {
  if (currentPlayer !== player) return;
  // 先取消当前身份和事件监听. pause/load 或迟到的 play() 拒绝不能清掉下一轮播放器.
  currentPlayer = null;
  player.mediaListeners.abort();
  player.audio.pause();
  player.audio.removeAttribute('src');
  player.audio.load();
  player.source?.disconnect();
  player.source = null;
  stopMouthTracking();
}

function finishPlayer(player: SpeechPlayer): void {
  if (currentPlayer !== player) return;
  disposePlayer(player);
  sessionPresentation.playbackEnded(player.sessionId, player.turnId);
  startPendingSpeechPlayback();
}

function failPlayer(player: SpeechPlayer, message: string): void {
  if (currentPlayer !== player) return;
  finishPlayer(player);
  showToast(message, { variant: 'warning' });
}

function mediaErrorMessage(error: MediaError | null): string {
  switch (error?.code) {
    case 2:
      return '音频读取失败，请检查本地服务是否仍在运行';
    case 3:
      return '浏览器无法解码该轮音频';
    case 4:
      return '该轮音频不可用或格式不受浏览器支持';
    default:
      return '语音播放失败';
  }
}

export function replayTurn(sessionId: string, turnId: string): void {
  // 主动播放替换本地队列, 但不取消原队列中任何后台生成任务.
  if (currentPlayer) disposePlayer(currentPlayer);
  sessionPresentation.clearPlayback();
  sessionPresentation.enqueueSpeech(sessionId, turnId);
  const player = createPlayer(sessionId, turnId, false);
  void playUrl(player);
}

/** 停止当前播放并清空待播项, 不取消后台生成. */
export function stopTurnPlayback(sessionId: string, turnId: string): void {
  if (!sessionPresentation.owns(sessionId, turnId)) return;
  if (currentPlayer) disposePlayer(currentPlayer);
  sessionPresentation.clearPlayback();
}

export function stopSessionPlayback(sessionId: string): void {
  const key = usePlaybackStore.getState().queue[0];
  if (key?.sessionId === sessionId) stopTurnPlayback(sessionId, key.turnId);
}

/** 根 Turn 失败或取消只移除该项, 其他已排队 Turn 仍可继续播放. */
export function removeTurnPlayback(sessionId: string, turnId: string): void {
  const player = currentPlayer;
  if (player?.sessionId === sessionId && player.turnId === turnId) disposePlayer(player);
  sessionPresentation.removeTurn(sessionId, turnId);
  startPendingSpeechPlayback();
}

/** Server 已完成归档或删除后停止本地读取; 不再发送一次生成取消命令. */
export function removeSessionPlayback(sessionId: string): void {
  const player = currentPlayer;
  if (player?.sessionId === sessionId) disposePlayer(player);
  sessionPresentation.cancelSession(sessionId);
  startPendingSpeechPlayback();
}
