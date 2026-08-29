import { create } from 'zustand';


import { tauriBridge } from './tauri-bridge.js';
import { showToast } from './toast.js';
import { turnsApi } from '../api/turns.js';
import { serverClient } from '../api/client.js';
import type { TurnSseEvent } from '@ema-agent/server/sse/eventHub.js';
import { useCurrentSession } from '../chat/state/currentSession.js';
import type { EmaLipSync } from './wlipsync-lipsync.js';
import { createEmaLipSync } from './wlipsync-lipsync.js';

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

// ── wLipSync 唇同步（lazy init，失败回退 RMS） ──────────────────────────────
//
// wLipSync 元音识别替代 RMS 音量包络：Ema 模型无分元音嘴型参数，元音权重
// 聚合为单一 mouthOpen 写入 speech-store.rms（live2d-react audio-lipsync
// 插件逻辑不变，只是 rms 的含义从"音量"变为"元音嘴张开度"）。
// WASM 运行时加载失败（Tauri CSP / data: URL worklet 被拦）时保持 null，
// RMS loop 回退到 analyser 音量包络。

let lipSyncHelper: EmaLipSync | null = null;
let lipSyncInitPromise: Promise<EmaLipSync | null> | null = null;

async function ensureLipSync(): Promise<EmaLipSync | null> {
  if (lipSyncHelper) return lipSyncHelper;
  if (!lipSyncInitPromise) {
    lipSyncInitPromise = createEmaLipSync(ensureAudioCtx().ctx)
      .then((helper) => {
        lipSyncHelper = helper;
        return helper;
      })
      .catch((err) => {
        // 运行时 WASM/worklet 加载失败不阻塞播放，回退 RMS
        console.error('[tts-playback] wLipSync 初始化失败，回退 RMS 音量包络', err);
        return null;
      });
  }
  return lipSyncInitPromise;
}

function connectLipSyncSource(source: AudioNode): void {
  if (lipSyncHelper) {
    lipSyncHelper.connectSource(source);
    return;
  }
  // init 是 async：未就绪则就绪后再接入当前源；失败静默（已 log）
  void ensureLipSync().then((helper) => helper?.connectSource(source));
}

// ── Speech state broadcasting ─────────────────────────────────────────────────

let lastPublishAt = 0;

function publishSpeechState(
  state: { speaking: boolean; rms: number },
  force = false,
): void {
  const now = performance.now();
  if (!force && now - lastPublishAt < 33) return;
  lastPublishAt = now;
  void tauriBridge.emit('stage:speech-state', state);
}

// ── RMS loop ──────────────────────────────────────────────────────────────────

let rmsRaf = 0;

function startRmsLoop(): void {
  if (rmsRaf) return;
  publishSpeechState({ speaking: true, rms: 0 }, true);
  // fire-and-forget 启动 wLipSync 初始化；就绪前 loop 使用 RMS fallback
  void ensureLipSync();

  const loop = (): void => {
    // 优先使用 wLipSync 元音识别的 mouthOpen；未就绪或初始化失败时回退 RMS 音量包络
    let rms: number;
    if (lipSyncHelper) {
      rms = lipSyncHelper.getMouthOpen();
    } else {
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
      // 原始音量包络正常说话只有 0.02~0.3，放大到与 wLipSync 一致的 0..1 开口度域
      rms = Math.min(1, Math.sqrt(sum / rmsData.length) * 3);
    }
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
  publishSpeechState({ speaking: false, rms: 0 }, true);
}

// ── TurnPlayer ────────────────────────────────────────────────────────────────
//
// One per active turn. Two playback modes chosen by the first chunk's mime:
//   'mse'    — MediaSource + SourceBuffer streaming(mp3/aac;WebView2 支持良好)。
//   'decode' — 句级 decodeAudioData 兜底(wav/pcm 等 MSE 不支持的容器)。
//              GPT-SoVITS(AAC)与 Qwen-TTS(WAV)都按句交付,句界事件到来时
//              解码并顺序排播,保住句级流式体验。
// 两种模式都接入共享 AnalyserNode,唇同步链路一致。

interface TurnPlayer {
  sessionId: string;
  turnId:    string;
  mime:      string;
  mode:      'mse' | 'decode';
  // ── mse 模式字段(decode 模式为 null)──
  mediaSource:   MediaSource | null;
  sourceBuffer:  SourceBuffer | null;
  objectUrl:     string | null;
  audioEl:       HTMLAudioElement | null;
  elementSource: MediaElementAudioSourceNode | null;
  pendingChunks: ArrayBuffer[];
  // ── decode 模式字段 ──
  pendingBytes:      Uint8Array[];
  decodeChain:       Promise<void>;
  scheduledSources:  Set<AudioBufferSourceNode>;
  nextStartTime:     number;
  stopped:       boolean;
  completed:     boolean;
}

const activePlayers   = new Map<string, TurnPlayer>(); // turnId → player
const sessionToTurnId = new Map<string, string>();     // sessionId → turnId

/** 返回 MediaSource 实际支持的 mime 写法,不支持时返回 null(走 decode 兜底)。 */
function mseSupportedMime(mime: string): string | null {
  const base = mime.split(';')[0]!.trim();
  const candidates = [base];
  // Chromium 的 MSE 对 wav 需要显式 PCM codec 写法,两个都试。
  if (base === 'audio/wav' || base === 'audio/x-wav' || base === 'audio/L16' || base === 'audio/pcm') {
    candidates.push('audio/wav; codecs="1"');
  }
  for (const candidate of candidates) {
    if (MediaSource.isTypeSupported(candidate)) return candidate;
  }
  return null;
}

function createPlayer(sessionId: string, turnId: string, mime: string): TurnPlayer {
  const { ctx, analyser } = ensureAudioCtx();
  if (ctx.state === 'suspended') {
    ctx.resume().catch((err: Error) => {
      // Autoplay policy keeps the context suspended until a user gesture —
      // the #1 cause of "silent TTS with zero logs". Make it loud.
      console.error('[tts-playback] AudioContext.resume() failed:', err.name, err.message);
    });
  }

  const player: TurnPlayer = {
    sessionId, turnId, mime,
    mode:          'decode',
    mediaSource:   null,
    sourceBuffer:  null,
    objectUrl:     null,
    audioEl:       null,
    elementSource: null,
    pendingChunks: [],
    pendingBytes:  [],
    decodeChain:   Promise.resolve(),
    scheduledSources: new Set(),
    nextStartTime: 0,
    stopped:       false,
    completed:     false,
  };

  const supported = mseSupportedMime(mime);
  if (supported) {
    player.mode = 'mse';
    const mediaSource  = new MediaSource();
    const objectUrl    = URL.createObjectURL(mediaSource);
    const audioEl      = new Audio();
    const elementSource = ctx.createMediaElementSource(audioEl);
    elementSource.connect(analyser);
    connectLipSyncSource(elementSource);
    player.mediaSource   = mediaSource;
    player.objectUrl     = objectUrl;
    player.audioEl       = audioEl;
    player.elementSource = elementSource;

    mediaSource.addEventListener('sourceopen', () => {
      if (player.stopped) return;
      try {
        const sb = mediaSource.addSourceBuffer(supported);
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
  } else {
    console.warn(`[tts-playback] MediaSource 不支持 ${mime}，回退句级解码播放`);
  }

  return player;
}

function flushPending(player: TurnPlayer): void {
  if (player.mode !== 'mse') return;
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
    if (player.mediaSource?.readyState === 'open') player.mediaSource.endOfStream();
  } catch { /* already ended or detached */ }
}

// ── decode 模式:句级解码与顺序排播 ────────────────────────────────────────────

/** 把当前累积的一句字节解码并按序排播;decode 串行链保序,失败只丢该句。 */
function scheduleSentence(player: TurnPlayer): void {
  if (player.mode !== 'decode' || player.pendingBytes.length === 0) return;
  const total = player.pendingBytes.reduce((size, b) => size + b.byteLength, 0);
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const part of player.pendingBytes) {
    bytes.set(part, offset);
    offset += part.byteLength;
  }
  player.pendingBytes = [];

  player.decodeChain = player.decodeChain.then(async () => {
    if (player.stopped) return;
    let audioBuffer: AudioBuffer;
    try {
      const { ctx } = ensureAudioCtx();
      // decodeAudioData 会 detach 输入;复制一份保持调用方语义无关。
      audioBuffer = await ctx.decodeAudioData(
        bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer,
      );
    } catch (err) {
      console.error('[tts-playback] 句子解码失败,跳过该句', err);
      return;
    }
    if (player.stopped) return;

    const { ctx, analyser } = ensureAudioCtx();
    const source = ctx.createBufferSource();
    source.buffer = audioBuffer;
    source.connect(analyser);
    connectLipSyncSource(source);
    player.scheduledSources.add(source);
    const startAt = Math.max(ctx.currentTime + 0.02, player.nextStartTime);
    source.start(startAt);
    player.nextStartTime = startAt + audioBuffer.duration;
    source.onended = () => {
      player.scheduledSources.delete(source);
      maybeFinishDecode(player);
    };
  });
}

/** decode 模式的终态:turn 完成、无待解码、无在播,才算整轮播完。 */
function maybeFinishDecode(player: TurnPlayer): void {
  if (player.mode !== 'decode' || player.stopped) return;
  if (!player.completed) return;
  if (player.pendingBytes.length > 0) return;
  void player.decodeChain.then(() => {
    if (!player.stopped && player.scheduledSources.size === 0) onPlaybackEnded();
  });
}

function destroyPlayer(player: TurnPlayer): void {
  player.stopped = true;
  player.pendingBytes = [];
  for (const source of player.scheduledSources) {
    try { source.stop(); } catch { /* already stopped */ }
  }
  player.scheduledSources.clear();
  if (player.audioEl) {
    player.audioEl.pause();
    player.audioEl.src = '';
  }
  try { player.elementSource?.disconnect(); } catch { /* already disconnected */ }
  try {
    if (player.mediaSource?.readyState === 'open') player.mediaSource.endOfStream();
  } catch { /* fine */ }
  if (player.objectUrl) URL.revokeObjectURL(player.objectUrl);
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
  return useCurrentSession.getState().ttsOwnerSessionId === sessionId;
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Feed a `tts_chunk` SSE event. Immediately streams the decoded bytes into the
 * MediaSource SourceBuffer so playback begins on the first chunk, not after
 * the sentence is complete.
 *
 * Only processes events for the current ttsOwner session.
 */
export function handleTtsChunk(
  event: Extract<TurnSseEvent, { type: 'tts_chunk' }>,
): void {
  // Evicted chunks (replayed after the audio file was finalized) keep their
  // 重放事件保留游标但不携带音频；实时音频已播放，断线后不重复补播。
  if (!event.audio) return;
  if (!isTtsOwner(event.sessionId)) return;

  const turnId    = event.turnId;
  const sessionId = event.sessionId;

  let player: TurnPlayer | null | undefined = activePlayers.get(turnId);

  if (!player) {
    // A new turn started for this session — tear down any prior player.
    const prevTurnId = sessionToTurnId.get(sessionId);
    if (prevTurnId) {
      const prev = activePlayers.get(prevTurnId);
      if (prev) destroyPlayer(prev);
    }

    player = createPlayer(sessionId, turnId, event.mime);
    activePlayers.set(turnId, player);
    sessionToTurnId.set(sessionId, turnId);
    setPlaying(turnId);
    startRmsLoop();
  }

  if (player.stopped) return;

  const binary = atob(event.audio);
  const bytes  = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i)!;

  if (player.mode === 'decode') {
    player.pendingBytes.push(bytes);
    return;
  }

  player.pendingChunks.push(bytes.buffer as ArrayBuffer);
  if (player.sourceBuffer) flushPending(player);
}

/**
 * `tts_sentence_complete` — sentence boundary marker from the backend.
 * mse 模式句界透明(SourceBuffer 连续累积);decode 模式据此解码并排播当前句。
 */
export function handleTtsSentenceComplete(
  event: Extract<TurnSseEvent, { type: 'tts_sentence_complete' }>,
): void {
  if (!isTtsOwner(event.sessionId)) return;
  const turnId = sessionToTurnId.get(event.sessionId);
  const player = turnId ? activePlayers.get(turnId) : undefined;
  if (player && player.mode === 'decode' && !player.stopped) {
    scheduleSentence(player);
  }
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
  if (player.mode === 'decode') {
    // 尾句可能没有句界事件(截断/单边),兜底冲刷。
    scheduleSentence(player);
    maybeFinishDecode(player);
    return;
  }
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
 * Fetches the turn's archived audio from the server and plays it through the
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
  const url     = await turnsApi.audioUrl(turnId);
  const headers = await serverClient.getAuthHeaders();
  const res     = await fetch(url, { headers });
  if (!res.ok) throw new Error(`[tts-playback] replay fetch failed: ${res.status}`);

  const arrayBuffer = await res.arrayBuffer();
  const audioBuffer = await ctx.decodeAudioData(arrayBuffer);

  const source = ctx.createBufferSource();
  source.buffer = audioBuffer;
  source.connect(analyser);
  connectLipSyncSource(source);

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

/** Session 从前端缓存移除时释放对应播放器。 */
export function evictSessionPlayers(sessionId: string): void {
  stopTtsPlayback(sessionId);
}

