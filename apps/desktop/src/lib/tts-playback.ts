import { create } from 'zustand';
import type { SpeechControlEvent } from '@ema-agent/server/routes/ws/speech.js';
import { turnsApi } from '../api/turns.js';
import { tauriBridge } from './tauri-bridge.js';
import { showToast } from './toast.js';
import type { EmaLipSync } from './wlipsync-lipsync.js';
import { createEmaLipSync } from './wlipsync-lipsync.js';

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
let lastSpeechPublish = 0;

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

function publishSpeech(speaking: boolean, mouthOpen: number, force = false): void {
  const now = performance.now();
  if (!force && now - lastSpeechPublish < 33) return;
  lastSpeechPublish = now;
  void tauriBridge.publishStageSpeech(speaking, mouthOpen);
}

function startMouthTracking(): void {
  if (mouthTrackingFrame) return;
  publishSpeech(true, 0, true);
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
    publishSpeech(true, mouthOpen);
    mouthTrackingFrame = requestAnimationFrame(frame);
  };
  frame();
}

function stopMouthTracking(): void {
  if (mouthTrackingFrame) cancelAnimationFrame(mouthTrackingFrame);
  mouthTrackingFrame = 0;
  publishSpeech(false, 0, true);
}

function setPlaying(turnId: string | null): void {
  if (usePlaybackStore.getState().playingTurnId !== turnId) {
    usePlaybackStore.setState({ playingTurnId: turnId });
  }
}

export interface LiveSpeechPlayback {
  onControl(event: SpeechControlEvent): void;
  onAudio(bytes: ArrayBuffer): void;
  socketClosed(): void;
  stop(): void;
}

interface LivePlayer {
  readonly sessionId: string;
  readonly turnId: string;
  currentSentenceId: string | null;
  currentChunks: Uint8Array[];
  playChain: Promise<void>;
  activeSource: AudioBufferSourceNode | null;
  stopped: boolean;
  completed: boolean;
  readonly cancelSpeech: () => void;
}

const livePlayers = new Map<string, LivePlayer>();
const sessionTurns = new Map<string, string>();
let replaySource: AudioBufferSourceNode | null = null;

export function beginLiveSpeech(
  sessionId: string,
  turnId: string,
  sentencePlayed: (sentenceId: string) => void,
  cancelSpeech: () => void,
): LiveSpeechPlayback {
  stopTtsPlayback(sessionId);
  const player: LivePlayer = {
    sessionId,
    turnId,
    currentSentenceId: null,
    currentChunks: [],
    playChain: Promise.resolve(),
    activeSource: null,
    stopped: false,
    completed: false,
    cancelSpeech,
  };
  livePlayers.set(turnId, player);
  sessionTurns.set(sessionId, turnId);

  return {
    onControl(event) {
      if (player.stopped) return;
      if (event.type === 'sentence_started') {
        player.currentSentenceId = event.sentenceId;
        player.currentChunks = [];
      } else if (event.type === 'sentence_completed') {
        const bytes = joinChunks(player.currentChunks);
        player.currentChunks = [];
        player.currentSentenceId = null;
        player.playChain = player.playChain
          .then(() => playSentence(player, bytes))
          .catch(error => console.error('[tts-playback] 句子播放失败', error))
          .finally(() => sentencePlayed(event.sentenceId));
      } else if (event.type === 'sentence_failed') {
        player.currentChunks = [];
        player.currentSentenceId = null;
        showToast(`语音合成失败：${event.message}`, { variant: 'warning' });
      } else if (event.type === 'speech_completed') {
        player.completed = true;
        void player.playChain.finally(() => finishLivePlayer(player));
      } else if (event.type === 'speech_cancelled') {
        destroyLivePlayer(player);
      }
    },
    onAudio(bytes) {
      if (!player.stopped && player.currentSentenceId) {
        player.currentChunks.push(new Uint8Array(bytes));
      }
    },
    socketClosed() {
      if (!player.completed) destroyLivePlayer(player);
    },
    stop() {
      destroyLivePlayer(player);
    },
  };
}

async function playSentence(player: LivePlayer, bytes: Uint8Array): Promise<void> {
  if (player.stopped || bytes.byteLength === 0) return;
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
  if (sessionTurns.get(player.sessionId) === player.turnId) sessionTurns.delete(player.sessionId);
  setPlaying(null);
  stopMouthTracking();
}

function destroyLivePlayer(player: LivePlayer): void {
  if (player.stopped) return;
  player.stopped = true;
  player.currentChunks = [];
  try { player.activeSource?.stop(); } catch { /* 已经自然结束。 */ }
  player.activeSource = null;
  livePlayers.delete(player.turnId);
  if (sessionTurns.get(player.sessionId) === player.turnId) sessionTurns.delete(player.sessionId);
  if (usePlaybackStore.getState().playingTurnId === player.turnId) setPlaying(null);
  stopMouthTracking();
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

export function stopTtsPlayback(sessionId: string): void {
  const turnId = sessionTurns.get(sessionId);
  const player = turnId ? livePlayers.get(turnId) : undefined;
  if (player) {
    player.cancelSpeech();
    destroyLivePlayer(player);
  }
}

export function handleTurnAborted(sessionId: string): void {
  stopTtsPlayback(sessionId);
}

export async function replayTurn(turnId: string): Promise<void> {
  stopPlayback();
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

export function stopPlayback(): void {
  for (const player of [...livePlayers.values()]) destroyLivePlayer(player);
  if (replaySource) {
    try { replaySource.stop(); } catch { /* 已经自然结束。 */ }
    replaySource = null;
  }
  setPlaying(null);
  stopMouthTracking();
}

export function evictSessionPlayers(sessionId: string): void {
  stopTtsPlayback(sessionId);
}
