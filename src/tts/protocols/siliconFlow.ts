// 执行 SiliconFlow 的参考音频注册与流式语音合成协议。
import { readFile, stat } from 'node:fs/promises';
import { Readable } from 'node:stream';
import type { ReadableStream } from 'node:stream/web';

import { TtsError, ttsErrorFromHttp, ttsErrorFromNetwork } from '../errors.js';
import type {
  TtsConnection,
  PcmAudioFormat,
  TtsProtocolImplementation,
  TtsRequest,
  TtsStreamEvent,
} from '../types.js';
import { mimeFromExt, safeReadText } from '../utils.js';
import { pcmEvents } from '../audio/pcm.js';

const MAX_REFERENCE_AUDIO_BYTES = 25 * 1024 * 1024;
const SILICON_FLOW_PCM_FORMAT: PcmAudioFormat = { sampleRate: 24_000, channelCount: 1 };

export function createSiliconFlowTtsProtocol(
  connection: TtsConnection,
  modelId: string,
): TtsProtocolImplementation {
  const baseUrl = (connection.baseUrl ?? 'https://api.siliconflow.cn/v1').replace(/\/$/, '');
  const authorization = `Bearer ${connection.apiKey ?? ''}`;

  return {
    async prepareVoice(reference, signal) {
      const fileStat = await stat(reference.audioPath).catch((error: unknown) => {
        throw new TtsError('tts/reference_audio_missing', 'TTS reference audio is not readable', error);
      });
      if (fileStat.size > MAX_REFERENCE_AUDIO_BYTES) {
        throw new TtsError(
          'tts/resource_exhausted',
          `TTS reference audio exceeds ${MAX_REFERENCE_AUDIO_BYTES} bytes`,
        );
      }
      const bytes = await readFile(reference.audioPath);
      const extension = reference.resourceName.split('.').pop()?.toLowerCase() ?? '';
      const form = new FormData();
      form.set(
        'file',
        new Blob([new Uint8Array(bytes)], { type: mimeFromExt(extension) }),
        reference.resourceName,
      );
      form.set('model', modelId);
      form.set('customName', reference.registrationName);
      form.set('text', reference.promptText);

      let response: Response;
      try {
        response = await fetch(`${baseUrl}/uploads/audio/voice`, {
          method: 'POST',
          headers: { Authorization: authorization },
          body: form,
          signal,
        });
      } catch (error) {
        throw ttsErrorFromNetwork(error, signal);
      }
      if (!response.ok) {
        throw ttsErrorFromHttp(response.status, await safeReadText(response));
      }
      const payload = await response.json() as { uri?: string };
      if (!payload.uri) {
        throw new TtsError('tts/invalid_response', 'SiliconFlow voice upload response is missing uri');
      }
      return { kind: 'provider', id: payload.uri };
    },
    synthesize(request) {
      return synthesizeSiliconFlow(baseUrl, authorization, modelId, request);
    },
  };
}

async function* synthesizeSiliconFlow(
  baseUrl: string,
  authorization: string,
  modelId: string,
  request: TtsRequest,
): AsyncGenerator<TtsStreamEvent> {
  if (request.voice.kind !== 'provider') {
    throw new TtsError('tts/unsupported_voice', 'SiliconFlow TTS requires a registered provider voice');
  }

  const startedAt = Date.now();
  let response: Response;
  try {
    response = await fetch(`${baseUrl}/audio/speech`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: authorization },
      body: JSON.stringify({
        model: modelId,
        voice: request.voice.id,
        input: request.text,
        response_format: 'pcm',
        // TODO: 新增模型时核对 PCM 的采样率和声道约定. 此处明确请求 24 kHz, 不使用供应商默认值.
        sample_rate: SILICON_FLOW_PCM_FORMAT.sampleRate,
        stream: true,
        ...(request.speed === undefined ? {} : { speed: request.speed }),
      }),
      signal: request.signal,
    });
  } catch (error) {
    throw ttsErrorFromNetwork(error, request.signal);
  }
  if (!response.ok) {
    throw ttsErrorFromHttp(response.status, await safeReadText(response));
  }
  if (!response.body) throw new TtsError('tts/invalid_response', 'TTS response has no body');
  const input = Readable.fromWeb(response.body as ReadableStream<Uint8Array>);
  try {
    yield* pcmEvents(input, SILICON_FLOW_PCM_FORMAT, startedAt);
  } catch (error) {
    if (error instanceof TtsError) throw error;
    throw ttsErrorFromNetwork(error, request.signal);
  } finally {
    input.destroy();
  }
}
