import { TTSError } from './errors.js';
import { createDashscopeTTSProtocol } from './protocols/dashscope/index.js';
import { createGptSoVitsTTSProtocol } from './protocols/gptSoVits.js';
import { createSiliconFlowTTSProtocol } from './protocols/siliconFlow.js';
import type {
  CallTTS,
  TTSConnection,
  TTSProtocolImplementation,
  TTSRequest,
  TTSStreamEvent,
  TTSVoiceReference,
  TTSVoiceRegistrar,
} from './types.js';

export function createTTSVoiceRegistrar(
  connection: TTSConnection,
  modelId: string,
): TTSVoiceRegistrar {
  const implementation = createProtocol(connection, requireModelId(modelId));
  return (reference, signal) => {
    validateReference(reference);
    return implementation.prepareVoice(reference, signal);
  };
}

export function createTTSCall(connection: TTSConnection, modelId: string): CallTTS {
  const implementation = createProtocol(connection, requireModelId(modelId));
  return request => {
    validateRequest(request);
    return validateStream(implementation.synthesize(request));
  };
}

function createProtocol(connection: TTSConnection, modelId: string): TTSProtocolImplementation {
  switch (connection.protocol) {
    case 'siliconflow-tts': return createSiliconFlowTTSProtocol(connection, modelId);
    case 'gpt-sovits-tts': return createGptSoVitsTTSProtocol(connection, modelId);
    case 'dashscope-tts': return createDashscopeTTSProtocol(connection, modelId);
  }
}

function requireModelId(modelId: string): string {
  if (!modelId.trim()) throw new TypeError('TTS modelId must not be empty');
  return modelId;
}

function validateReference(reference: TTSVoiceReference): void {
  if (!reference.audioPath.trim()) {
    throw new TTSError('tts/invalid_request', 'TTS reference audio path must not be empty');
  }
}

function validateRequest(request: TTSRequest): void {
  if (!request.text.trim()) {
    throw new TTSError('tts/invalid_request', 'TTS text must not be empty');
  }
  if (request.speed !== undefined && (!Number.isFinite(request.speed) || request.speed <= 0)) {
    throw new TTSError('tts/invalid_request', 'TTS speed must be positive');
  }
}

async function* validateStream(
  stream: AsyncIterable<TTSStreamEvent>,
): AsyncGenerator<TTSStreamEvent> {
  // 所有协议都需满足同一播放顺序, 避免播放器先收到样本却还不知道如何解释它们.
  let terminal = false;
  let countedBytes = 0;
  let blockAlign = 0;
  for await (const event of stream) {
    if (terminal) {
      throw new TTSError('tts/invalid_response', 'TTS protocol emitted data after done');
    }
    if (event.type === 'audio_started') {
      if (blockAlign !== 0 || !Number.isSafeInteger(event.sampleRate)
        || event.sampleRate < 8_000 || event.sampleRate > 192_000
        || (event.channelCount !== 1 && event.channelCount !== 2)) {
        throw new TTSError('tts/invalid_response', 'TTS protocol emitted invalid or duplicate PCM format');
      }
      blockAlign = event.channelCount * 2;
    } else if (event.type === 'audio_chunk') {
      if (blockAlign === 0 || event.bytes.byteLength === 0 || event.bytes.byteLength % blockAlign !== 0) {
        throw new TTSError('tts/invalid_response', 'TTS protocol emitted invalid PCM frames or no format');
      }
      countedBytes += event.bytes.byteLength;
    } else {
      terminal = true;
      if (countedBytes === 0 || countedBytes % blockAlign !== 0) {
        throw new TTSError('tts/invalid_response', 'TTS protocol completed without audio');
      }
      if (event.totalBytes !== countedBytes) {
        throw new TTSError('tts/invalid_response', 'TTS protocol reported inconsistent byte count');
      }
    }
    yield event;
  }
  if (!terminal) {
    throw new TTSError('tts/invalid_response', 'TTS protocol ended without done');
  }
}
