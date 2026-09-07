// 执行 SiliconFlow 的参考音频注册与流式语音合成协议。
import { readFile, stat } from 'node:fs/promises';

import { TtsError, ttsErrorFromHttp, ttsErrorFromNetwork } from '../errors.js';
import type {
  TtsConnection,
  TtsProtocolImplementation,
  TtsRequest,
  TtsStreamEvent,
} from '../types.js';
import { concatBytes, mimeForFormat, mimeFromExt, safeReadText } from '../utils.js';

const CHUNK_BYTES = 8 * 1024;
const MAX_REFERENCE_AUDIO_BYTES = 25 * 1024 * 1024;

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

  let response: Response;
  try {
    response = await fetch(`${baseUrl}/audio/speech`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: authorization },
      body: JSON.stringify({
        model: modelId,
        voice: request.voice.id,
        input: request.text,
        response_format: request.format ?? 'mp3',
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
  const reader = response.body?.getReader();
  if (!reader) throw new TtsError('tts/invalid_response', 'TTS response has no body');

  const startedAt = Date.now();
  const mime = response.headers.get('content-type') ?? mimeForFormat(request.format ?? 'mp3');
  let firstByteMs = 0;
  let totalBytes = 0;
  let pending: Uint8Array<ArrayBufferLike> = new Uint8Array(0);

  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      if (!value?.byteLength) continue;
      if (firstByteMs === 0) firstByteMs = Date.now() - startedAt;
      totalBytes += value.byteLength;
      pending = concatBytes(pending, value);
      while (pending.byteLength >= CHUNK_BYTES) {
        yield { type: 'audio_chunk', bytes: pending.slice(0, CHUNK_BYTES), mime };
        pending = pending.slice(CHUNK_BYTES);
      }
    }
  } catch (error) {
    throw ttsErrorFromNetwork(error, request.signal);
  }
  if (pending.byteLength > 0) yield { type: 'audio_chunk', bytes: pending, mime };
  yield { type: 'done', totalBytes, firstByteMs };
}
