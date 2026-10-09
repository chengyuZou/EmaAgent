// 执行 DashScope Qwen TTS Realtime 协议, 音频 delta 到达后即可交付 PCM.
import WebSocket from 'ws';

import { TtsError } from '../../errors.js';
import type { PcmAudioFormat, TtsRequest, TtsStreamEvent } from '../../types.js';
import { SocketEventQueue } from './socketEventQueue.js';
import { pcmEvents } from '../../audio/pcm.js';

const MAX_PCM_BYTES = 16 * 1024 * 1024;
const QWEN_TTS_PCM_FORMAT: PcmAudioFormat = { sampleRate: 24_000, channelCount: 1 };

export async function* synthesizeQwenTts(
  webSocketBaseUrl: string,
  apiKey: string,
  modelId: string,
  request: TtsRequest,
): AsyncGenerator<TtsStreamEvent> {
  if (request.voice.kind !== 'provider') {
    throw new TtsError('tts/unsupported_voice', 'DashScope Qwen TTS requires a prepared provider voice');
  }

  request.signal?.throwIfAborted();
  const url = `${webSocketBaseUrl.replace(/\/$/, '')}/api-ws/v1/realtime?model=${encodeURIComponent(modelId)}`;
  const queue = new SocketEventQueue<Uint8Array>();
  const startedAt = Date.now();
  let pcmBytes = 0;
  let completed = false;
  let aborted = false;
  let socket: WebSocket;

  try {
    socket = new WebSocket(url, { headers: { Authorization: `Bearer ${apiKey}` } });
  } catch (error) {
    throw new TtsError('tts/network', 'Unable to open DashScope Qwen TTS WebSocket', error);
  }

  const onAbort = (): void => {
    aborted = true;
    queue.fail(new TtsError('tts/aborted', 'DashScope Qwen TTS request was aborted'));
    socket.close(1000, 'aborted');
  };
  request.signal?.addEventListener('abort', onAbort, { once: true });

  socket.on('open', () => {
    socket.send(JSON.stringify({
      type: 'session.update',
      event_id: eventId(),
      session: {
        voice: request.voice.kind === 'provider' ? request.voice.id : '',
        response_format: 'pcm',
        // TODO: 扩展模型族时核对限制. Qwen-TTS-Realtime 只支持 24 kHz; 此处明确指定, 与输出的 PCM 声明一致.
        sample_rate: QWEN_TTS_PCM_FORMAT.sampleRate,
        mode: 'commit',
      },
    }));
    socket.send(JSON.stringify({
      type: 'input_text_buffer.append',
      event_id: eventId(),
      text: request.text,
    }));
    socket.send(JSON.stringify({ type: 'input_text_buffer.commit', event_id: eventId() }));
  });

  socket.on('message', (data) => {
    if (aborted || completed) return;
    let message: { type?: string; delta?: string; error?: { message?: string } };
    try {
      message = JSON.parse(data.toString('utf8'));
    } catch {
      return;
    }
    if (message.type === 'response.audio.delta' && typeof message.delta === 'string') {
      const chunk = Buffer.from(message.delta, 'base64');
      pcmBytes += chunk.byteLength;
      if (pcmBytes > MAX_PCM_BYTES) {
        completed = true;
        queue.fail(new TtsError('tts/resource_exhausted', 'DashScope Qwen TTS PCM exceeds 16 MiB'));
        socket.close(1009, 'audio too large');
        return;
      }
      queue.push(chunk);
      return;
    }
    if (message.type === 'response.done') {
      socket.send(JSON.stringify({ type: 'session.finish', event_id: eventId() }));
      return;
    }
    if (message.type === 'session.finished') {
      completed = true;
      queue.close();
      socket.close(1000, 'completed');
      return;
    }
    if (message.type === 'error') {
      completed = true;
      const detail = message.error?.message ?? 'DashScope Qwen TTS failed';
      queue.fail(new TtsError(
        detail.toLowerCase().includes('auth') ? 'tts/credentials' : 'tts/provider_error',
        detail,
      ));
      socket.close(1000, 'failed');
    }
  });

  socket.on('error', (error) => {
    if (!aborted && !completed) queue.fail(new TtsError('tts/network', error.message, error));
  });
  socket.on('close', (code) => {
    if (!aborted && !completed) {
      queue.fail(new TtsError('tts/network', `DashScope Qwen TTS WebSocket closed (${code})`));
    }
  });

  try {
    yield* pcmEvents(queue.iterate(), QWEN_TTS_PCM_FORMAT, startedAt);
  } finally {
    request.signal?.removeEventListener('abort', onAbort);
    if (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CONNECTING) {
      socket.close();
    }
  }
}

function eventId(): string {
  return `event_${Date.now()}_${Math.floor(Math.random() * 1000)}`;
}
