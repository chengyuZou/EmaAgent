// 按 DashScope 模型族注册参考音频，并返回只允许进程内缓存的声音标识。
import { readFile, stat } from 'node:fs/promises';
import { extname } from 'node:path';

import { TtsError, ttsErrorFromHttp, ttsErrorFromNetwork } from '../../errors.js';
import type { TtsProviderVoice, TtsVoiceReference } from '../../types.js';
import { safeReadText } from '../../utils.js';

const MAX_REFERENCE_AUDIO_BYTES = 25 * 1024 * 1024;

export async function enrollDashscopeVoice(
  httpBaseUrl: string,
  apiKey: string,
  family: 'cosyvoice' | 'qwen-tts',
  reference: TtsVoiceReference,
  model: string,
  signal?: AbortSignal,
): Promise<TtsProviderVoice> {
  const fileStat = await stat(reference.audioPath).catch((error: unknown) => {
    throw new TtsError('tts/reference_audio_missing', 'TTS reference audio is not readable', error);
  });
  if (fileStat.size > MAX_REFERENCE_AUDIO_BYTES) {
    throw new TtsError(
      'tts/resource_exhausted',
      `TTS reference audio exceeds ${MAX_REFERENCE_AUDIO_BYTES} bytes`,
    );
  }

  const audio = await readFile(reference.audioPath);
  const extension = extname(reference.audioPath).slice(1).toLowerCase() || 'wav';
  const mime = extension === 'mp3'
    ? 'audio/mpeg'
    : extension === 'm4a' ? 'audio/mp4' : `audio/${extension}`;
  const dataUri = `data:${mime};base64,${audio.toString('base64')}`;
  const body = family === 'cosyvoice'
    ? {
        model: 'voice-enrollment',
        input: {
          action: 'create_voice',
          target_model: model,
          prefix: 'ema',
          url: dataUri,
        },
      }
    : {
        model: 'qwen-voice-enrollment',
        input: {
          action: 'create',
          target_model: model,
          preferred_name: 'ema',
          audio: { data: dataUri },
        },
      };

  let response: Response;
  try {
    response = await fetch(
      `${httpBaseUrl.replace(/\/$/, '')}/api/v1/services/audio/tts/customization`,
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${apiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(body),
        signal,
      },
    );
  } catch (error) {
    throw ttsErrorFromNetwork(error, signal);
  }
  if (!response.ok) {
    throw ttsErrorFromHttp(response.status, await safeReadText(response));
  }
  const payload = await response.json() as {
    output?: { voice_id?: string; voice?: string };
  };
  const voiceId = payload.output?.voice_id ?? payload.output?.voice;
  if (!voiceId) {
    throw new TtsError('tts/invalid_response', 'DashScope voice enrollment response is missing voice id');
  }
  return { kind: 'provider', id: voiceId, lifetime: 'ephemeral' };
}
