// 创建一个绑定协议连接的文本转语音入口，并统一校验中立请求和流终态。
import { TtsError } from './errors.js';
import { createDashscopeTtsProtocol } from './protocols/dashscope/index.js';
import { createGptSoVitsTtsProtocol } from './protocols/gptSoVits.js';
import { createOpenAiTtsProtocol } from './protocols/openAi.js';
import type {
  TtsConnection,
  TtsProtocolImplementation,
  TtsRequest,
  TtsStreamEvent,
  TtsVoice,
  TtsVoiceReference,
} from './types.js';

export interface TextToSpeech {
  readonly protocol: TtsConnection['protocol'];
  /** 本地协议原样返回参考音频，云端协议在这里注册声音。 */
  prepareVoice(
    reference: TtsVoiceReference,
    model: string,
    signal?: AbortSignal,
  ): Promise<TtsVoice>;
  /** 执行一次已切分文本的语音合成。 */
  synthesize(request: TtsRequest): AsyncIterable<TtsStreamEvent>;
}

/** TTS 唯一创建入口；不保存 Provider Map、Session、Usage 或重试状态。 */
export function createTextToSpeech(connection: TtsConnection): TextToSpeech {
  const implementation = createProtocol(connection);
  return {
    protocol: connection.protocol,
    prepareVoice(reference, model, signal) {
      validateReference(reference, model);
      return implementation.prepareVoice(reference, model, signal);
    },
    synthesize(request) {
      validateRequest(request);
      return validateStream(implementation.synthesize(request));
    },
  };
}

function createProtocol(connection: TtsConnection): TtsProtocolImplementation {
  switch (connection.protocol) {
    case 'openai-tts': return createOpenAiTtsProtocol(connection);
    case 'gpt-sovits-tts': return createGptSoVitsTtsProtocol(connection);
    case 'dashscope-tts': return createDashscopeTtsProtocol(connection);
  }
}

function validateReference(reference: TtsVoiceReference, model: string): void {
  if (!model.trim()) throw new TtsError('tts/invalid_request', 'TTS model must not be empty');
  if (!reference.audioPath.trim()) {
    throw new TtsError('tts/invalid_request', 'TTS reference audio path must not be empty');
  }
}

function validateRequest(request: TtsRequest): void {
  if (!request.model.trim()) throw new TtsError('tts/invalid_request', 'TTS model must not be empty');
  if (!request.text.trim()) throw new TtsError('tts/invalid_request', 'TTS text must not be empty');
  if (request.sampleRate !== undefined && (!Number.isSafeInteger(request.sampleRate) || request.sampleRate <= 0)) {
    throw new TtsError('tts/invalid_request', 'TTS sampleRate must be a positive integer');
  }
  if (request.speed !== undefined && (!Number.isFinite(request.speed) || request.speed <= 0)) {
    throw new TtsError('tts/invalid_request', 'TTS speed must be positive');
  }
}

async function* validateStream(
  stream: AsyncIterable<TtsStreamEvent>,
): AsyncGenerator<TtsStreamEvent> {
  let terminal = false;
  let countedBytes = 0;
  for await (const event of stream) {
    if (terminal) throw new TtsError('tts/invalid_response', 'TTS protocol emitted data after done');
    if (event.type === 'audio_chunk') {
      if (event.bytes.byteLength === 0 || !event.mime.trim()) {
        throw new TtsError('tts/invalid_response', 'TTS protocol emitted an empty audio chunk');
      }
      countedBytes += event.bytes.byteLength;
    } else {
      terminal = true;
      if (countedBytes === 0) {
        throw new TtsError('tts/invalid_response', 'TTS protocol completed without audio');
      }
      if (event.totalBytes !== countedBytes) {
        throw new TtsError('tts/invalid_response', 'TTS protocol reported inconsistent byte count');
      }
    }
    yield event;
  }
  if (!terminal) throw new TtsError('tts/invalid_response', 'TTS protocol ended without done');
}
