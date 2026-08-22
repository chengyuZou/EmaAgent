// TTS 的两个创建入口：音色注册与逐句合成，协议连接与模型在创建点冻结。
import { TtsError } from './errors.js';
import { createDashscopeTtsProtocol } from './protocols/dashscope/index.js';
import { createGptSoVitsTtsProtocol } from './protocols/gptSoVits.js';
import { createOpenAiTtsProtocol } from './protocols/openAi.js';
import type {
  CallTts,
  TtsConnection,
  TtsProtocolImplementation,
  TtsRequest,
  TtsStreamEvent,
  TtsVoiceReference,
  TtsVoiceRegistrar,
} from './types.js';

/** 音色注册创建入口；不保存 Provider Map、Session、Usage 或重试状态。 */
export function createTtsVoiceRegistrar(
  connection: TtsConnection,
  modelId: string,
): TtsVoiceRegistrar {
  const implementation = createProtocol(connection, requireModelId(modelId));
  return (reference, signal) => {
    validateReference(reference);
    return implementation.prepareVoice(reference, signal);
  };
}

/** 逐句合成创建入口；返回的音频流必须经公共校验以唯一 done 结束。 */
export function createTtsCall(connection: TtsConnection, modelId: string): CallTts {
  const implementation = createProtocol(connection, requireModelId(modelId));
  return request => {
    validateRequest(request);
    return validateStream(implementation.synthesize(request));
  };
}

function createProtocol(connection: TtsConnection, modelId: string): TtsProtocolImplementation {
  switch (connection.protocol) {
    case 'openai-tts': return createOpenAiTtsProtocol(connection, modelId);
    case 'gpt-sovits-tts': return createGptSoVitsTtsProtocol(connection, modelId);
    case 'dashscope-tts': return createDashscopeTtsProtocol(connection, modelId);
  }
}

function requireModelId(modelId: string): string {
  if (!modelId.trim()) throw new TypeError('TTS modelId must not be empty');
  return modelId;
}

function validateReference(reference: TtsVoiceReference): void {
  if (!reference.audioPath.trim()) {
    throw new TtsError('tts/invalid_request', 'TTS reference audio path must not be empty');
  }
}

function validateRequest(request: TtsRequest): void {
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
