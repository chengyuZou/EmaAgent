// ── TTS Playback Manager ────────────────────────────────────────────────────
//
// Consumes `tts_chunk` / `tts_sentence_complete` SSE events, decodes base64
// audio chunks, plays them sequentially through the Web Audio API, and
// writes real-time RMS volume to SpeechAnimationStore so Live2D plugins
// can drive lip-sync and speech-emphasis body animation.
//
// Singleton — only one AudioContext and one active queue at a time.
// Sentence audio chunks are already ordered by the backend (TtsCoordinator
// synthesizes sequentially). Within a sentence, `tts_chunk` events arrive
// in playback order. Across sentences, the queue drains in FIFO order.

import type { EmaStreamEvent } from '@ema-agent/contracts';
import { useSpeechStore } from '@ema-agent/live2d-react';
import { tauriBridge } from './tauri-bridge.js';

interface SpeechStatePayload {
  speaking: boolean;
  rms: number;
}

// ── Audio infrastructure (lazy-init) ─────────────────────────────────────────

let audioCtx: AudioContext | null = null;
let analyser: AnalyserNode | null = null;
let rmsBinCount = 0;
let rmsData: Uint8Array | null = null;

function ensureAudio(): { ctx: AudioContext; analyser: AnalyserNode } {
  if (!audioCtx) {
    audioCtx = new AudioContext();
    analyser = audioCtx.createAnalyser();
    analyser.fftSize = 256;
    analyser.smoothingTimeConstant = 0.4;
    analyser.connect(audioCtx.destination);
    rmsBinCount = analyser.frequencyBinCount;
    rmsData = new Uint8Array(rmsBinCount);
  }
  return { ctx: audioCtx!, analyser: analyser! };
}

// ── RMS extraction loop ──────────────────────────────────────────────────────

let rmsRaf = 0;
let lastSpeechPublishAt = 0;
let speechChannel: BroadcastChannel | null = null;

function getSpeechChannel(): BroadcastChannel | null {
  if (typeof BroadcastChannel === 'undefined') return null;
  if (!speechChannel) {
    speechChannel = new BroadcastChannel('ema-stage-speech');
  }
  return speechChannel;
}

function publishSpeechState(payload: SpeechStatePayload, force = false): void {
  const now = performance.now();
  if (!force && now - lastSpeechPublishAt < 33) return;
  lastSpeechPublishAt = now;

  getSpeechChannel()?.postMessage(payload);
  void tauriBridge.emit('stage:speech-state', payload);
}

function startRmsLoop(): void {
  if (rmsRaf) return;
  publishSpeechState({ speaking: true, rms: 0 }, true);
  const loop = (): void => {
    const { analyser } = ensureAudio();
    if (!rmsData || rmsData.length !== rmsBinCount) {
      rmsData = new Uint8Array(rmsBinCount);
    }
    analyser.getByteTimeDomainData(rmsData as unknown as Uint8Array<ArrayBuffer>);
    let sum = 0;
    for (let i = 0; i < rmsData!.length; i++) {
      const v = (rmsData![i]! - 128) / 128;
      sum += v * v;
    }
    const rms = Math.sqrt(sum / rmsData!.length);
    useSpeechStore.getState().setRms(rms);
    publishSpeechState({ speaking: true, rms });
    rmsRaf = requestAnimationFrame(loop);
  };
  loop();
}

function stopRmsLoop(): void {
  if (rmsRaf) { cancelAnimationFrame(rmsRaf); rmsRaf = 0; }
  useSpeechStore.getState().reset();
  publishSpeechState({ speaking: false, rms: 0 }, true);
}

// ── Audio chunk queue ────────────────────────────────────────────────────────

interface AudioItem {
  decode: Promise<AudioBuffer>;
  sentenceId: string;
  byteLength: number;
}

interface PendingSentence {
  chunks: Uint8Array[];
  byteLength: number;
}

let queue: AudioItem[] = [];
let playing = false;
let currentSentenceId: string | null = null;
const pendingSentences = new Map<string, PendingSentence>();

async function drainQueue(): Promise<void> {
  if (playing || queue.length === 0) return;
  playing = true;
  startRmsLoop();
  useSpeechStore.getState().setSpeaking(true);

  const { ctx, analyser } = ensureAudio();
  if (ctx.state === 'suspended') {
    try { await ctx.resume(); } catch { /* browser may reject without gesture */ }
  }

  while (queue.length > 0) {
    const item = queue.shift()!;
    currentSentenceId = item.sentenceId;

    try {
      const audioBuffer = await item.decode;
      const source = ctx.createBufferSource();
      source.buffer = audioBuffer;
      source.connect(analyser);

      await new Promise<void>((resolve) => {
        source.onended = () => resolve();
        source.start();
      });
    } catch (err) {
      console.error('[tts-playback] decode/play error for sentence', item.sentenceId, err);
    }
  }

  stopRmsLoop();
  useSpeechStore.getState().setSpeaking(false);
  currentSentenceId = null;
  playing = false;
}

function enqueueSentence(sentenceId: string, bytes: Uint8Array): void {
  const { ctx } = ensureAudio();
  const decode = ctx.decodeAudioData(toOwnedArrayBuffer(bytes));
  decode.catch(() => { /* handled when drainQueue awaits this item */ });
  queue.push({ decode, sentenceId, byteLength: bytes.byteLength });
  void drainQueue();
}

function appendChunk(sentenceId: string, bytes: Uint8Array): number {
  let pending = pendingSentences.get(sentenceId);
  if (!pending) {
    pending = { chunks: [], byteLength: 0 };
    pendingSentences.set(sentenceId, pending);
  }
  pending.chunks.push(bytes);
  pending.byteLength += bytes.byteLength;
  return pending.byteLength;
}

function completeSentence(sentenceId: string): Uint8Array | null {
  const pending = pendingSentences.get(sentenceId);
  if (!pending) return null;
  pendingSentences.delete(sentenceId);

  const merged = new Uint8Array(pending.byteLength);
  let offset = 0;
  for (const chunk of pending.chunks) {
    merged.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return merged;
}

function toOwnedArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  return copy.buffer;
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Call from chat-store's SSE dispatch when a `tts_chunk` event arrives.
 * Decodes the base64 payload and enqueues it for playback.
 */
export function handleTtsChunk(event: EmaStreamEvent & { type: 'tts_chunk' }): void {
  try {
    console.log('[tts-playback] raw chunk received, audioLen=', event.audio?.length);
    const binary = atob(event.audio);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    const total = appendChunk(event.sentenceId, bytes);
    console.log('[tts-playback] chunk buffered, sentenceId=', event.sentenceId, 'bytes=', bytes.length, 'total=', total);
  } catch(err) {
    console.error('[tts-playback] base64 decode failed:', err, 'audio sample=', event.audio?.slice(0, 20));
  }
}

/**
 * Call from chat-store's SSE dispatch when a `tts_sentence_complete` event arrives.
 * The queue drainer handles sentence boundaries naturally — this is a no-op
 * marker reserved for future use (e.g. pre-buffer next sentence).
 */
export function handleTtsSentenceComplete(event: EmaStreamEvent & { type: 'tts_sentence_complete' }): void {
  const bytes = completeSentence(event.sentenceId);
  if (!bytes || bytes.byteLength === 0) {
    console.log('[tts-playback] sentence complete without audio, sentenceId=', event.sentenceId);
    return;
  }

  console.log('[tts-playback] sentence complete, sentenceId=', event.sentenceId, 'bytes=', bytes.byteLength, 'queue.length=', queue.length);
  enqueueSentence(event.sentenceId, bytes);
}

// ── Test harness ─────────────────────────────────────────────────────────────

/**
 * Test the full Web Audio → RMS → speech-store pipeline with an arbitrary
 * audio buffer. Call from browser console to verify lip-sync visually:
 *
 *   const res = await fetch('/test-audio.mp3');
 *   const buf = await res.arrayBuffer();
 *   window.__testTtsPlayback(buf);
 *
 * The Live2D mouth should move in sync with the audio.
 */
export async function testTtsPlayback(arrayBuffer: ArrayBuffer): Promise<void> {
  const { ctx } = ensureAudio();
  startRmsLoop();
  useSpeechStore.getState().setSpeaking(true);

  try {
    const audioBuffer = await ctx.decodeAudioData(arrayBuffer.slice(0) as ArrayBuffer);
    const source = ctx.createBufferSource();
    source.buffer = audioBuffer;
    source.connect(ensureAudio().analyser);

    await new Promise<void>((resolve) => {
      source.onended = () => resolve();
      source.start();
    });
  } catch (err) {
    console.error('[tts-playback] test playback failed', err);
  } finally {
    stopRmsLoop();
    useSpeechStore.getState().setSpeaking(false);
  }
}

// Expose for browser console
if (typeof window !== 'undefined') {
  (window as any).__testTtsPlayback = testTtsPlayback;
}
