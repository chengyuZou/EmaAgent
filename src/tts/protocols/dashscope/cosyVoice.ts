// 执行 DashScope CosyVoice 的 run-task/continue-task/finish-task WebSocket 协议。
import { randomUUID } from 'node:crypto';
import WebSocket from 'ws';

import { TtsError } from '../../errors.js';
import type { TtsRequest, TtsStreamEvent } from '../../types.js';
import { mimeForFormat } from '../../utils.js';
import { SocketEventQueue } from './socketEventQueue.js';

export async function* synthesizeCosyVoice(
  webSocketBaseUrl: string,
  apiKey: string,
  modelId: string,
  request: TtsRequest,
): AsyncGenerator<TtsStreamEvent> {
  if (request.voice.kind !== 'provider') {
    throw new TtsError('tts/unsupported_voice', 'DashScope CosyVoice requires a prepared provider voice');
  }

  const url = `${webSocketBaseUrl.replace(/\/$/, '')}/api-ws/v1/inference/`;
  const taskId = randomUUID().replace(/-/g, '');
  const queue = new SocketEventQueue<TtsStreamEvent>();
  const startedAt = Date.now();
  const mime = mimeForFormat(request.format ?? 'mp3');
  let firstByteMs = 0;
  let totalBytes = 0;
  let completed = false;
  let aborted = false;
  let socket: WebSocket;

  try {
    socket = new WebSocket(url, {
      headers: {
        Authorization: `bearer ${apiKey}`,
        'X-DashScope-DataInspection': 'enable',
      },
    });
  } catch (error) {
    throw new TtsError('tts/network', 'Unable to open DashScope CosyVoice WebSocket', error);
  }
  socket.binaryType = 'nodebuffer';

  const onAbort = (): void => {
    aborted = true;
    queue.fail(new TtsError('tts/aborted', 'DashScope CosyVoice request was aborted'));
    socket.close(1000, 'aborted');
  };
  request.signal?.addEventListener('abort', onAbort, { once: true });

  socket.on('open', () => {
    socket.send(JSON.stringify({
      header: { action: 'run-task', task_id: taskId, streaming: 'duplex' },
      payload: {
        task_group: 'audio',
        task: 'tts',
        function: 'SpeechSynthesizer',
        model: modelId,
        parameters: {
          text_type: 'PlainText',
          voice: request.voice.kind === 'provider' ? request.voice.id : '',
          format: request.format ?? 'mp3',
          sample_rate: request.sampleRate ?? defaultSampleRate(request.format ?? 'mp3'),
          volume: 50,
          rate: request.speed ?? 1,
          pitch: 1,
          enable_ssml: false,
        },
        input: {},
      },
    }));
  });

  socket.on('message', (data, isBinary) => {
    if (aborted || completed) return;
    if (isBinary) {
      const buffer = data as Buffer;
      if (firstByteMs === 0) firstByteMs = Date.now() - startedAt;
      totalBytes += buffer.byteLength;
      queue.push({ type: 'audio_chunk', bytes: new Uint8Array(buffer), mime });
      return;
    }

    let message: { header?: { event?: string; error_message?: string } };
    try {
      message = JSON.parse(data.toString('utf8'));
    } catch {
      return;
    }
    if (message.header?.event === 'task-started') {
      socket.send(JSON.stringify({
        header: { action: 'continue-task', task_id: taskId, streaming: 'duplex' },
        payload: { input: { text: request.text } },
      }));
      socket.send(JSON.stringify({
        header: { action: 'finish-task', task_id: taskId, streaming: 'duplex' },
        payload: { input: {} },
      }));
      return;
    }
    if (message.header?.event === 'task-finished') {
      completed = true;
      queue.push({ type: 'done', totalBytes, firstByteMs });
      queue.close();
      socket.close(1000, 'completed');
      return;
    }
    if (message.header?.event === 'task-failed') {
      completed = true;
      const detail = message.header.error_message ?? 'DashScope CosyVoice task failed';
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
      queue.fail(new TtsError('tts/network', `DashScope CosyVoice WebSocket closed (${code})`));
    }
  });

  try {
    yield* queue.iterate();
  } finally {
    request.signal?.removeEventListener('abort', onAbort);
    if (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CONNECTING) {
      socket.close();
    }
  }
}

function defaultSampleRate(format: string): number {
  return format === 'pcm' ? 24_000 : 22_050;
}
