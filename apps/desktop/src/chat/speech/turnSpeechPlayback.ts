import { create } from 'zustand';
import type { SpeechControlEvent } from '@ema-agent/server/routes/ws/speech.js';
import { openSpeechSocket, type SpeechSocketHandle } from '../../api/speechWebSocket.js';
import { turnsApi } from '../../api/turns.js';
import { tauriBridge } from '../../lib/tauri-bridge.js';
import { showToast } from '../../lib/toast.js';
import type { EmaLipSync } from '../../lib/wlipsync-lipsync.js';
import { createEmaLipSync } from '../../lib/wlipsync-lipsync.js';
import { sessionPresentation } from '../presentation/sessionPresentation.js';

interface PlaybackState {
  playingTurnId: string | null;
}

export const usePlaybackStore = create<PlaybackState>(() => ({ playingTurnId: null }));

let audioContext: AudioContext | null = null;
let analyser: AnalyserNode | null = null;
let fallbackVolumeData: Uint8Array | null = null;
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
  if (!lipSyncPromise) {
    lipSyncPromise = createEmaLipSync(audioGraph().context)
      .then(value => {
        lipSync = value;
        return value;
      })
      .catch(error => {
        console.error('[tts-playback] wLipSync 初始化失败，改用音量包络', error);
        return null;
      });
  }
  return lipSyncPromise;
}

function connectLipSync(source: AudioNode): void {
  if (lipSync) lipSync.connectSource(source);
  else void ensureLipSync().then(value => value?.connectSource(source));
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
  void ensureLipSync();
  const frame = (): void => {
    let mouthOpen = lipSync?.getMouthOpen();
    if (mouthOpen === undefined) {
      const graph = audioGraph();
      if (!fallbackVolumeData || fallbackVolumeData.length !== graph.analyser.frequencyBinCount) {
        fallbackVolumeData = new Uint8Array(graph.analyser.frequencyBinCount);
      }
      graph.analyser.getByteTimeDomainData(
        fallbackVolumeData as Uint8Array<ArrayBuffer>,
      );
      let sum = 0;
      for (const sample of fallbackVolumeData) {
        const value = (sample - 128) / 128;
        sum += value * value;
      }
      mouthOpen = Math.min(
        1,
        Math.sqrt(sum / fallbackVolumeData.length) * 3,
      );
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

function setPlaying(turnId: string | null): void {
  if (usePlaybackStore.getState().playingTurnId !== turnId) {
    usePlaybackStore.setState({ playingTurnId: turnId });
  }
}

interface LivePlayer {
  readonly sessionId: string;
  readonly turnId: string;
  currentSentenceId: string | null;
  currentChunks: Uint8Array[];
  /**
   * Server 可以在上一句仍播放时继续送来下一句. 每个句子追加到这条 Promise 链,
   * 保证扬声器按原顺序播放; speech_completed 必须等这条链结束后才能结算 Claim.
   */
  playChain: Promise<void>;
  activeSource: AudioBufferSourceNode | null;
  stopped: boolean;
  completed: boolean;
  settled: boolean;
  socket: SpeechSocketHandle | null;
}

const livePlayers = new Map<string, LivePlayer>();
let replaySource: AudioBufferSourceNode | null = null;

export function startTurnSpeechPlayback(sessionId: string, turnId: string): void {
  if (livePlayers.has(turnId)) return;
  const player: LivePlayer = {
    sessionId,
    turnId,
    currentSentenceId: null,
    currentChunks: [],
    playChain: Promise.resolve(),
    activeSource: null,
    stopped: false,
    completed: false,
    settled: false,
    socket: null,
  };
  livePlayers.set(turnId, player);
  sessionPresentation.claim(sessionId, turnId, true, () => destroyLivePlayer(player, true));
  void openSpeechSocket(turnId, {
    onControl: event => receiveSpeechControl(player, event),
    onAudio: bytes => {
      if (!player.stopped && player.currentSentenceId) {
        player.currentChunks.push(new Uint8Array(bytes));
      }
    },
    onClosed: () => {
      if (!player.completed) destroyLivePlayer(player, false);
    },
  }).then(socket => {
    if (player.stopped) {
      socket.cancel();
      return;
    }
    player.socket = socket;
  }).catch(() => destroyLivePlayer(player, false));
}

function receiveSpeechControl(player: LivePlayer, event: SpeechControlEvent): void {
  if (player.stopped) return;
  if (event.type === 'sentence_started') {
    player.currentSentenceId = event.sentenceId;
    player.currentChunks = [];
    return;
  }
  if (event.type === 'sentence_completed') {
    const bytes = joinChunks(player.currentChunks);
    player.currentChunks = [];
    player.currentSentenceId = null;
    player.playChain = player.playChain
      .then(() => playSentence(player, bytes))
      .catch(error => console.error('[turn-speech] 句子播放失败', error))
      .finally(() => player.socket?.sentencePlayed(event.sentenceId));
    return;
  }
  if (event.type === 'sentence_failed') {
    player.currentChunks = [];
    player.currentSentenceId = null;
    showToast(`语音合成失败: ${event.message}`, { variant: 'warning' });
    return;
  }
  if (event.type === 'speech_completed') {
    player.completed = true;
    void player.playChain.finally(() => finishLivePlayer(player));
    return;
  }
  if (event.type === 'speech_cancelled') destroyLivePlayer(player, false);
}

async function playSentence(player: LivePlayer, bytes: Uint8Array): Promise<void> {
  if (player.stopped || bytes.byteLength === 0) return;
  await sessionPresentation.whenActive(player.sessionId, player.turnId);
  if (player.stopped) return;
  const { context, analyser: output } = audioGraph();
  if (context.state === 'suspended') await context.resume();
  const buffer = await context.decodeAudioData(
    bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer,
  );
  if (player.stopped) return;

  const source = context.createBufferSource();
  source.buffer = buffer;
  source.connect(output);
  connectLipSync(source);
  player.activeSource = source;
  setPlaying(player.turnId);
  startMouthTracking();
  await new Promise<void>(resolve => {
    source.onended = () => resolve();
    source.start();
  });
  if (player.activeSource === source) player.activeSource = null;
  stopMouthTracking();
}

function finishLivePlayer(player: LivePlayer): void {
  if (player.stopped || !player.completed || player.activeSource) return;
  livePlayers.delete(player.turnId);
  setPlaying(null);
  stopMouthTracking();
  settlePlayer(player);
}

function destroyLivePlayer(player: LivePlayer, cancelServer = false): void {
  if (player.stopped) return;
  player.stopped = true;
  player.currentChunks = [];
  if (cancelServer) player.socket?.cancel();
  player.socket = null;
  try { player.activeSource?.stop(); } catch { /* 已经自然结束。 */ }
  player.activeSource = null;
  livePlayers.delete(player.turnId);
  if (usePlaybackStore.getState().playingTurnId === player.turnId) setPlaying(null);
  stopMouthTracking();
  settlePlayer(player);
}

function settlePlayer(player: LivePlayer): void {
  if (player.settled) return;
  player.settled = true;
  sessionPresentation.speechSettled(player.sessionId, player.turnId);
}

function joinChunks(chunks: readonly Uint8Array[]): Uint8Array {
  const output = new Uint8Array(chunks.reduce((total, chunk) => total + chunk.byteLength, 0));
  let offset = 0;
  for (const chunk of chunks) {
    output.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return output;
}

export function cancelTurnSpeech(turnId: string): void {
  const player = livePlayers.get(turnId);
  if (player) destroyLivePlayer(player, true);
}

export async function replayTurn(turnId: string): Promise<void> {
  if (livePlayers.size > 0) {
    showToast('实时语音尚未结束', { variant: 'info' });
    return;
  }
  stopReplay();
  const { context, analyser: output } = audioGraph();
  if (context.state === 'suspended') await context.resume();
  const response = await turnsApi.readAudio(turnId);
  const buffer = await context.decodeAudioData(await response.arrayBuffer());
  const source = context.createBufferSource();
  source.buffer = buffer;
  source.connect(output);
  connectLipSync(source);
  replaySource = source;
  setPlaying(turnId);
  startMouthTracking();
  try {
    await new Promise<void>(resolve => {
      source.onended = () => resolve();
      source.start();
    });
  } finally {
    if (replaySource === source) replaySource = null;
    setPlaying(null);
    stopMouthTracking();
  }
}

export function stopTurnPlayback(turnId: string): void {
  const player = livePlayers.get(turnId);
  if (player) {
    destroyLivePlayer(player, true);
    return;
  }
  if (usePlaybackStore.getState().playingTurnId === turnId) stopReplay();
}

function stopReplay(): void {
  if (replaySource) {
    try { replaySource.stop(); } catch { /* 已经自然结束。 */ }
    replaySource = null;
  }
  setPlaying(null);
  stopMouthTracking();
}
