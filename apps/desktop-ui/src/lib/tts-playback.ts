import { create } from 'zustand';
import type { TurnId } from '@ema-agent/ids';
import type { EmaStreamEvent } from '@ema-agent/turn';
import { useSpeechStore } from '@ema-agent/live2d-react';
import type { SpeechAnimationState } from '@ema-agent/live2d-react';
import { tauriBridge } from './tauri-bridge.js';
import { showToast } from './toast.js';
import { turnsApi } from '../api/turns.js';
import { sidecarClient } from '../api/sidecar-client.js';
import { useConversationStore } from '../stores/conversation-store.js';

// ── Playback state (subscribable) ─────────────────────────────────────────────
//
// Which turn's audio is audible right now (live stream OR replay). Components
// subscribe to render play/stop toggles; null = silence.

interface PlaybackState {
  playingTurnId: string | null;
}

export const usePlaybackStore = create<PlaybackState>(() => ({ playingTurnId: null }));

function setPlaying(turnId: string | null): void {
  if (usePlaybackStore.getState().playingTurnId !== turnId) {
    usePlaybackStore.setState({ playingTurnId: turnId });
  }
}

// ── Shared audio infrastructure (lazy-init) ───────────────────────────────────

let sharedCtx: AudioContext | null = null;
let sharedAnalyser: AnalyserNode | null = null;
let rmsData: Uint8Array | null = null;

function ensureAudioCtx(): { ctx: AudioContext; analyser: AnalyserNode } {
  if (!sharedCtx) {
    sharedCtx = new AudioContext();
    sharedAnalyser = sharedCtx.createAnalyser();
    sharedAnalyser.fftSize = 256;
    sharedAnalyser.smoothingTimeConstant = 0.4;
    sharedAnalyser.connect(sharedCtx.destination);
    rmsData = new Uint8Array(sharedAnalyser.frequencyBinCount);
  }
  return { ctx: sharedCtx!, analyser: sharedAnalyser! };
}

// ── Speech state broadcasting ─────────────────────────────────────────────────

let speechChannel: BroadcastChannel | null = null;
let lastPublishAt = 0;

function getSpeechChannel(): BroadcastChannel | null {
  if (typeof BroadcastChannel === 'undefined') return null;
  if (!speechChannel) speechChannel = new BroadcastChannel('ema-stage-speech');
  return speechChannel;
}

function publishSpeechState(
  state: Pick<SpeechAnimationState, 'speaking' | 'rms'>,
  force = false,
): void {
  const now = performance.now();
  if (!force && now - lastPublishAt < 33) return;
  lastPublishAt = now;
  getSpeechChannel()?.postMessage(state);
  void tauriBridge.emit('stage:speech-state', state);
}

// ── RMS loop ──────────────────────────────────────────────────────────────────

let rmsRaf = 0;

function startRmsLoop(): void {
  if (rmsRaf) return;
  publishSpeechState({ speaking: true, rms: 0 }, true);
  useSpeechStore.getState().setSpeaking(true);

  const loop = (): void => {
    const { analyser } = ensureAudioCtx();
    if (!rmsData || rmsData.length !== analyser.frequencyBinCount) {
      rmsData = new Uint8Array(analyser.frequencyBinCount);
    }
    analyser.getByteTimeDomainData(rmsData as Uint8Array<ArrayBuffer>);
    let sum = 0;
    for (let i = 0; i < rmsData.length; i++) {
      const v = (rmsData[i]! - 128) / 128;
      sum += v * v;
    }
    const rms = Math.sqrt(sum / rmsData.length);
    useSpeechStore.getState().setRms(rms);
    publishSpeechState({ speaking: true, rms });
    rmsRaf = requestAnimationFrame(loop);
  };
  loop();
}

function stopRmsLoop(): void {
  if (rmsRaf) {
    cancelAnimationFrame(rmsRaf);
    rmsRaf = 0;
  }
  useSpeechStore.getState().reset();
  publishSpeechState({ speaking: false, rms: 0 }, true);
}

// ── TurnPlayer ────────────────────────────────────────────────────────────────
//
// One per active turn. Owns a MediaSource + SourceBuffer backed HTMLAudioElement
// connected to the shared AnalyserNode so RMS-based lip-sync works without a
// separate decode pass.

interface TurnPlayer {
  sessionId: string;
  turnId:    string;
  mediaSource:   MediaSource;
  sourceBuffer:  SourceBuffer | null;
  objectUrl:     string;
  audioEl:       HTMLAudioElement;
  elementSource: MediaElementAudioSourceNode;
  pendingChunks: ArrayBuffer[];
  stopped:       boolean;
  completed:     boolean;
}

const activePlayers   = new Map<string, TurnPlayer>(); // turnId → player
const sessionToTurnId = new Map<string, string>();     // sessionId → turnId

function createPlayer(sessionId: string, turnId: string): TurnPlayer | null {
  if (!MediaSource.isTypeSupported('audio/mpeg')) {
    console.error('[tts-playback] audio/mpeg not supported by MediaSource');
    return null;
  }

  const { ctx, analyser } = ensureAudioCtx();
  if (ctx.state === 'suspended') {
    ctx.resume().catch((err: Error) => {
      // Autoplay policy keeps the context suspended until a user gesture —
      // the #1 cause of "silent TTS with zero logs". Make it loud.
      console.error('[tts-playback] AudioContext.resume() failed:', err.name, err.message);
    });
  }

  const mediaSource  = new MediaSource();
  const objectUrl    = URL.createObjectURL(mediaSource);
  const audioEl      = new Audio();
  const elementSource = ctx.createMediaElementSource(audioEl);
  elementSource.connect(analyser);

  const player: TurnPlayer = {
    sessionId, turnId,
    mediaSource, objectUrl, audioEl, elementSource,
    sourceBuffer:  null,
    pendingChunks: [],
    stopped:       false,
    completed:     false,
  };

  mediaSource.addEventListener('sourceopen', () => {
    if (player.stopped) return;
    try {
      const sb = mediaSource.addSourceBuffer('audio/mpeg');
      player.sourceBuffer = sb;
      sb.addEventListener('updateend', () => {
        if (!player.stopped) flushPending(player);
      });
      flushPending(player);
    } catch (err) {
      console.error('[tts-playback] SourceBuffer creation failed', err);
    }
  }, { once: true });

  audioEl.src = objectUrl;
  audioEl.addEventListener('ended', () => {
    if (!player.stopped) onPlaybackEnded();
  }, { once: true });

  audioEl.play().catch((err: Error) => {
    console.error('[tts-playback] play() rejected:', err.name, err.message);
    if (err.name === 'NotAllowedError') {
      // Safety net — should be unreachable once additionalBrowserArgs disables
      // the autoplay policy (tauri.conf.json), kept in case the flag regresses.
      showToast('音频被自动播放策略拦截，点击窗口任意处后重试', { variant: 'warning' });
    }
  });

  return player;
}

function flushPending(player: TurnPlayer): void {
  if (!player.sourceBuffer || player.sourceBuffer.updating) return;
  const next = player.pendingChunks.shift();
  if (next) {
    player.sourceBuffer.appendBuffer(next);
  } else if (player.completed) {
    tryEndStream(player);
  }
}

function tryEndStream(player: TurnPlayer): void {
  if (player.sourceBuffer?.updating || player.pendingChunks.length > 0) return;
  try {
    if (player.mediaSource.readyState === 'open') player.mediaSource.endOfStream();
  } catch { /* already ended or detached */ }
}

function destroyPlayer(player: TurnPlayer): void {
  player.stopped = true;
  player.audioEl.pause();
  player.audioEl.src = '';
  try { player.elementSource.disconnect(); } catch { /* already disconnected */ }
  try {
    if (player.mediaSource.readyState === 'open') player.mediaSource.endOfStream();
  } catch { /* fine */ }
  URL.revokeObjectURL(player.objectUrl);
  activePlayers.delete(player.turnId);
  if (sessionToTurnId.get(player.sessionId) === player.turnId) {
    sessionToTurnId.delete(player.sessionId);
  }
  if (usePlaybackStore.getState().playingTurnId === player.turnId) {
    setPlaying(null);
  }
}

function onPlaybackEnded(): void {
  stopRmsLoop();
  setPlaying(null);
}

// ── Owner check ───────────────────────────────────────────────────────────────

function isTtsOwner(sessionId: string): boolean {
  return (useConversationStore.getState().ttsOwnerSessionId as string) === sessionId;
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Feed a `tts_chunk` SSE event. Immediately streams the decoded bytes into the
 * MediaSource SourceBuffer so playback begins on the first chunk, not after
 * the sentence is complete.
 *
 * Only processes events for the current ttsOwner session.
 */
export function handleTtsChunk(event: EmaStreamEvent & { type: 'tts_chunk' }): void {
  // Evicted chunks (replayed after the audio file was finalized) keep their
  // cursor slot but carry no audio — see TurnEventStore.evictAudioChunks.
  if (!event.audio) return;
  if (!isTtsOwner(event.sessionId as string)) return;

  const turnId    = event.turnId as string;
  const sessionId = event.sessionId as string;

  let player: TurnPlayer | null | undefined = activePlayers.get(turnId);

  if (!player) {
    // A new turn started for this session — tear down any prior player.
    const prevTurnId = sessionToTurnId.get(sessionId);
    if (prevTurnId) {
      const prev = activePlayers.get(prevTurnId);
      if (prev) destroyPlayer(prev);
    }

    player = createPlayer(sessionId, turnId);
    if (!player) return;

    activePlayers.set(turnId, player);
    sessionToTurnId.set(sessionId, turnId);
    setPlaying(turnId);
    startRmsLoop();
  }

  if (player.stopped) return;

  const binary = atob(event.audio);
  const bytes  = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i)!;

  player.pendingChunks.push(bytes.buffer as ArrayBuffer);
  if (player.sourceBuffer) flushPending(player);
}

/**
 * `tts_sentence_complete` — sentence boundary marker from the backend.
 * In the new streaming design, playback has already started via the chunks.
 * This is a no-op for live playback; `handleTurnCompleted` signals end-of-stream.
 *
 * Only processes events for the current ttsOwner session.
 */
export function handleTtsSentenceComplete(
  event: EmaStreamEvent & { type: 'tts_sentence_complete' },
): void {
  if (!isTtsOwner(event.sessionId as string)) return;
  // No-op: sentence boundaries are transparent in the MediaSource streaming model.
  // The SourceBuffer accumulates all sentences continuously; endOfStream is called
  // once by handleTurnCompleted when the backend signals the full turn is done.
}

/**
 * Call when `turn_completed` fires for a session. Signals the SourceBuffer that
 * no more audio data is coming so the HTMLAudioElement can play to the end.
 */
export function handleTurnCompleted(sessionId: string): void {
  const turnId = sessionToTurnId.get(sessionId);
  if (!turnId) return;
  const player = activePlayers.get(turnId);
  if (!player || player.stopped) return;
  player.completed = true;
  if (player.sourceBuffer) flushPending(player);
  // If sourceBuffer isn't ready yet, completed=true will be picked up when
  // sourceopen fires and calls flushPending.
}

/**
 * Call when `turn_failed` or `turn_aborted` fires, or when the stop button
 * is pressed. Immediately halts audio and Live2D for the given session.
 */
export function handleTurnAborted(sessionId: string): void {
  stopTtsPlayback(sessionId);
}

/**
 * Stop all active audio for a session (stop-button path).
 * Tears down the player and resets Live2D speech state.
 */
export function stopTtsPlayback(sessionId: string): void {
  const turnId = sessionToTurnId.get(sessionId);
  if (turnId) {
    const player = activePlayers.get(turnId);
    if (player) destroyPlayer(player);
  }
  stopRmsLoop();
}

// The one replay source that may be live. Kept module-level so stopPlayback()
// can interrupt it — BufferSource has no pause, only stop() (fires onended).
let replaySource: AudioBufferSourceNode | null = null;

/**
 * Replay the merged audio for a completed turn.
 * Fetches the turn's archived audio from the sidecar and plays it through the
 * shared AnalyserNode so RMS lip-sync still works. No emotion events are emitted.
 *
 * Stops any currently playing audio (live or replay) before starting.
 * Interruptible via stopPlayback().
 */
export async function replayTurn(turnId: string): Promise<void> {
  stopPlayback();   // stop live players AND any in-flight replay

  const { ctx, analyser } = ensureAudioCtx();
  if (ctx.state === 'suspended') await ctx.resume().catch((err: Error) => { console.error('[tts-playback] AudioContext.resume() failed:', err.name, err.message); });

  // The audio route is auth-gated like every /api route — a bare fetch()
  // returns 401, which surfaced as "该轮没有可重播的语音" even though the
  // merged file was on disk. Attach the shared secret.
  const url     = await turnsApi.audioUrl(turnId as TurnId);
  const headers = await sidecarClient.getAuthHeaders();
  const res     = await fetch(url, { headers });
  if (!res.ok) throw new Error(`[tts-playback] replay fetch failed: ${res.status}`);

  const arrayBuffer = await res.arrayBuffer();
  const audioBuffer = await ctx.decodeAudioData(arrayBuffer);

  const source = ctx.createBufferSource();
  source.buffer = audioBuffer;
  source.connect(analyser);

  replaySource = source;
  setPlaying(turnId);
  startRmsLoop();

  try {
    await new Promise<void>((resolve) => {
      source.onended = () => resolve();   // fires on natural end AND on stop()
      source.start();
    });
  } finally {
    if (replaySource === source) replaySource = null;
    stopRmsLoop();
    setPlaying(null);
  }
}

/**
 * Stop ALL audible audio — live stream players, in-flight replay, RMS loop —
 * and reset Live2D speech state. The universal "■" button handler.
 */
export function stopPlayback(): void {
  for (const player of [...activePlayers.values()]) {
    destroyPlayer(player);
  }
  if (replaySource) {
    try { replaySource.stop(); } catch { /* already stopped */ }
    replaySource = null;
  }
  stopRmsLoop();
  setPlaying(null);
}

/**
 * Release all players for a session. Call from conversation-store.evictSession.
 */
export function evictSessionPlayers(sessionId: string): void {
  stopTtsPlayback(sessionId);
}

// ── Test harness ──────────────────────────────────────────────────────────────

export async function testTtsPlayback(arrayBuffer: ArrayBuffer): Promise<void> {
  const { ctx, analyser } = ensureAudioCtx();
  if (ctx.state === 'suspended') await ctx.resume().catch((err: Error) => { console.error('[tts-playback] AudioContext.resume() failed:', err.name, err.message); });

  const audioBuffer = await ctx.decodeAudioData(arrayBuffer.slice(0) as ArrayBuffer);
  const source = ctx.createBufferSource();
  source.buffer = audioBuffer;
  source.connect(analyser);

  startRmsLoop();

  await new Promise<void>((resolve) => {
    source.onended = () => resolve();
    source.start();
  });

  stopRmsLoop();
}

if (typeof window !== 'undefined') {
  (window as unknown as Record<string, unknown>).__testTtsPlayback = testTtsPlayback;
}
