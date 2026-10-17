import { randomUUID } from 'node:crypto';
import WebSocket from 'ws';

import { TTSError } from '../../errors.js';
import type { PcmAudioFormat, TTSRequest, TTSStreamEvent } from '../../types.js';
import { pcmEvents } from '../../audio/pcm.js';
import { SocketEventQueue } from './socketEventQueue.js';

const COSY_VOICE_PCM_FORMAT: PcmAudioFormat = { sampleRate: 24_000, channelCount: 1 };

export async function* synthesizeCosyVoice(
  webSocketBaseUrl: string,
  apiKey: string,
  modelId: string,
  request: TTSRequest,
): AsyncGenerator<TTSStreamEvent> {
  if (request.voice.kind !== 'provider') {
    throw new TTSError('tts/unsupported_voice', 'DashScope CosyVoice requires a prepared provider voice');
  }

  const url = `${webSocketBaseUrl.replace(/\/$/, '')}/api-ws/v1/inference/`;
  const taskId = randomUUID().replace(/-/g, '');
  request.signal?.throwIfAborted();
  const queue = new SocketEventQueue<Uint8Array>();
  const startedAt = Date.now();
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
    throw new TTSError('tts/network', 'Unable to open DashScope CosyVoice WebSocket', error);
  }
  socket.binaryType = 'nodebuffer';

  const onAbort = (): void => {
    aborted = true;
    queue.fail(new TTSError('tts/aborted', 'DashScope CosyVoice request was aborted'));
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
          format: 'pcm',
          // 返回的裸 PCM 没有文件头, 请求采样率必须与交付的音频格式一致.
          sample_rate: COSY_VOICE_PCM_FORMAT.sampleRate,
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
      queue.push(buffer);
      return;
    }

    let message: { header?: { event?: string; error_message?: string } };
    try {
      message = JSON.parse(data.toString('utf8'));
    } catch {
      return;
    }
    // 等供应商确认任务已创建再发送文本和结束输入, 两条消息共用同一个 taskId.
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
      queue.close();
      socket.close(1000, 'completed');
      return;
    }
    if (message.header?.event === 'task-failed') {
      completed = true;
      const detail = message.header.error_message ?? 'DashScope CosyVoice task failed';
      queue.fail(new TTSError(
        detail.toLowerCase().includes('auth') ? 'tts/credentials' : 'tts/provider_error',
        detail,
      ));
      socket.close(1000, 'failed');
    }
  });

  socket.on('error', (error) => {
    if (!aborted && !completed) queue.fail(new TTSError('tts/network', error.message, error));
  });
  socket.on('close', (code) => {
    if (!aborted && !completed) {
      queue.fail(new TTSError('tts/network', `DashScope CosyVoice WebSocket closed (${code})`));
    }
  });

  try {
    yield* pcmEvents(queue.iterate(), COSY_VOICE_PCM_FORMAT, startedAt);
  } finally {
    request.signal?.removeEventListener('abort', onAbort);
    if (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CONNECTING) {
      socket.close();
    }
  }
}
