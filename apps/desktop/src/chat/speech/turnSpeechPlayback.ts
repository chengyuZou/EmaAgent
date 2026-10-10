import { create } from 'zustand';
import type { SpeechGenerateEvent } from '@ema-agent/server/routes/ws/speech.js';
import { openSpeechSocket, type SpeechSocketHandle } from '../../api/speechWebSocket.js';
import { turnsApi } from '../../api/turns.js';
import { tauriBridge } from '../../lib/tauri-bridge.js';
import { showToast } from '../../lib/toast.js';
import { createEmaLipSync, type EmaLipSync } from '../../lib/wlipsync-lipsync.js';
import { sessionPresentation } from '../presentation/sessionPresentation.js';

export type PlaybackStatus = 'loading' | 'playing';

interface PlaybackState {
  playback: {
    readonly sessionId: string;
    readonly turnId: string;
    readonly status: PlaybackStatus;
  } | null;
}

export const usePlaybackStore = create<PlaybackState>(() => ({ playback: null }));

interface SpeechPlayer {
  readonly sessionId: string;
  readonly turnId: string;
  readonly origin: 'live' | 'history';
  readonly audio: HTMLAudioElement;
  readonly mediaListeners: AbortController;
  source: MediaElementAudioSourceNode | null;
  socket: SpeechSocketHandle | null;
  generationFinished: boolean;
  urlRequested: boolean;
  /** 用户在 WebSocket 握手完成前停止时, 握手成功后仍要把取消命令送给原来的 Turn. */
  cancelGeneration: boolean;
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
  const previous = usePlaybackStore.getState().playback;
  if (previous?.sessionId === player.sessionId
    && previous.turnId === player.turnId
    && previous.status === status) return;
  usePlaybackStore.setState({
    playback: { sessionId: player.sessionId, turnId: player.turnId, status },
  });
}

function createPlayer(sessionId: string, turnId: string, origin: SpeechPlayer['origin']): SpeechPlayer {
  const audio = new Audio();
  // 音频走 loopback Server, 与 WebView 页面不同源. 必须先设置 CORS 再赋 src,
  // 否则 MediaElementAudioSourceNode 会播放静音, 口型分析也拿不到采样.
  audio.crossOrigin = 'anonymous';
  audio.preload = 'auto';
  const player: SpeechPlayer = {
    sessionId,
    turnId,
    origin,
    audio,
    mediaListeners: new AbortController(),
    source: null,
    socket: null,
    generationFinished: origin === 'history',
    urlRequested: false,
    cancelGeneration: false,
  };
  currentPlayer = player;
  sessionPresentation.playbackStarted(sessionId, turnId);
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
  // 没有 owner 的 Turn 不连接本地播放器. Server 仍会独立完成合成和落盘.
  if (!sessionPresentation.claim(sessionId, turnId)) return;
  const player = createPlayer(sessionId, turnId, 'live');
  void openSpeechSocket(sessionId, turnId, {
    onControl: event => receiveSpeechControl(player, event),
    onClosed: () => {
      if (!player.generationFinished) failPlayer(player, '语音状态连接已断开，播放已停止');
    },
  }).then(socket => {
    if (currentPlayer !== player) {
      if (player.cancelGeneration) socket.cancel();
      else socket.close();
      return;
    }
    player.socket = socket;
  }).catch(error => failPlayer(
    player,
    error instanceof Error ? error.message : '语音状态连接失败',
  ));
}

function receiveSpeechControl(player: SpeechPlayer, event: SpeechGenerateEvent): void {
  if (currentPlayer !== player) return;
  switch (event.type) {
    case 'speech_generate_started':
      void playUrl(player);
      return;
    case 'speech_generate_warning':
      showToast(`语音合成失败: ${event.message}`, { variant: 'warning' });
      return;
    case 'speech_generate_completed':
      // Server 已写完文件, 不代表浏览器已播完. HTTP 读到文件尾后由 audio 的 ended 释放 owner.
      player.generationFinished = true;
      if (event.audioAvailable) void playUrl(player);
      else finishPlayer(player);
      return;
    case 'speech_generate_cancelled':
      player.generationFinished = true;
      finishPlayer(player);
      return;
    case 'speech_generate_failed':
      player.generationFinished = true;
      failPlayer(player, `语音生成失败: ${event.message}`);
      return;
    case 'speech_generate_unavailable':
      player.generationFinished = true;
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

function finishPlayer(player: SpeechPlayer, cancelGeneration = false): void {
  if (currentPlayer !== player) return;
  player.cancelGeneration = cancelGeneration && player.origin === 'live' && !player.generationFinished;
  // 先取消当前身份和事件监听. pause/load 或迟到的 play() 拒绝不能清掉下一轮播放器.
  currentPlayer = null;
  player.mediaListeners.abort();
  player.audio.pause();
  player.audio.removeAttribute('src');
  player.audio.load();
  player.source?.disconnect();
  player.source = null;
  if (player.cancelGeneration) player.socket?.cancel();
  else player.socket?.close();
  player.socket = null;
  stopMouthTracking();
  usePlaybackStore.setState({ playback: null });
  sessionPresentation.playbackEnded(player.sessionId, player.turnId);
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
  if (!sessionPresentation.claim(sessionId, turnId)) {
    showToast('当前对话仍在呈现或播放，请结束后再重播', { variant: 'info' });
    return;
  }
  const player = createPlayer(sessionId, turnId, 'history');
  void playUrl(player);
}

/** Footer 明确停止本轮播放. 实时生成也停止并保留已生成部分, 正文不受影响. */
export function stopTurnPlayback(sessionId: string, turnId: string): void {
  const player = currentPlayer;
  if (player?.sessionId === sessionId && player.turnId === turnId) finishPlayer(player, true);
}

/** Server 已完成归档或删除后停止本地读取; 不再发送一次生成取消命令. */
export function removeSessionPlayback(sessionId: string): void {
  const player = currentPlayer;
  if (player?.sessionId === sessionId) finishPlayer(player);
}
