import { readFile, stat } from 'node:fs/promises';
import { extname } from 'node:path';

import { TTSError, ttsErrorFromHttp, ttsErrorFromNetwork } from '../../errors.js';
import type { TTSProviderVoice, TTSVoiceReference } from '../../types.js';
import { safeReadText } from '../../utils.js';

const MAX_REFERENCE_AUDIO_BYTES = 25 * 1024 * 1024;
// 远端注册名称使用短 ASCII, 角色和参考资源的对应关系由 Speech 的本地缓存保存.
const DASHSCOPE_VOICE_PREFIX = 'emaagent';

export async function enrollDashscopeVoice(
  httpBaseUrl: string,
  apiKey: string,
  family: 'cosyvoice' | 'qwen-tts',
  reference: TTSVoiceReference,
  model: string,
  signal?: AbortSignal,
): Promise<TTSProviderVoice> {
  const fileStat = await stat(reference.audioPath).catch((error: unknown) => {
    throw new TTSError('tts/reference_audio_missing', 'TTS reference audio is not readable', error);
  });
  if (fileStat.size > MAX_REFERENCE_AUDIO_BYTES) {
    throw new TTSError(
      'tts/resource_exhausted',
      `TTS reference audio exceeds ${MAX_REFERENCE_AUDIO_BYTES} bytes`,
    );
  }

  const audio = await readFile(reference.audioPath);
  const extension = extname(reference.audioPath).slice(1).toLowerCase() || 'wav';
  let mime: string;
  if (extension === 'mp3') {
    mime = 'audio/mpeg';
  } else if (extension === 'm4a') {
    mime = 'audio/mp4';
  } else {
    mime = `audio/${extension}`;
  }
  const dataUri = `data:${mime};base64,${audio.toString('base64')}`;
  const body = family === 'cosyvoice'
    ? {
        model: 'voice-enrollment',
        input: {
          action: 'create_voice',
          target_model: model,
          prefix: DASHSCOPE_VOICE_PREFIX,
          url: dataUri,
        },
      }
    : {
        model: 'qwen-voice-enrollment',
        input: {
          action: 'create',
          target_model: model,
          preferred_name: DASHSCOPE_VOICE_PREFIX,
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
    throw new TTSError('tts/invalid_response', 'DashScope voice enrollment response is missing voice id');
  }
  return { kind: 'provider', id: voiceId };
}
