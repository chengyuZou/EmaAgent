import { STTError } from './errors.js';
import { createOpenAiSTTProtocol } from './protocols/openAi.js';
import type {
  CallSTT,
  STTConnection,
  TranscriptionResult,
} from './types.js';

export function createSTTCall(connection: STTConnection, modelId: string): CallSTT {
  if (!modelId.trim()) throw new STTError('stt/invalid_request', 'STT model must not be empty');
  const protocolTranscribe = createProtocolTranscribe(connection, modelId);
  return async (request) => {
    validateRequest(request);
    const result = await protocolTranscribe(request);
    validateResult(result);
    return result;
  };
}

function createProtocolTranscribe(
  connection: STTConnection,
  modelId: string,
): CallSTT {
  switch (connection.protocol) {
    case 'openai-stt': return createOpenAiSTTProtocol(connection, modelId);
  }
}

function validateRequest(request: Parameters<CallSTT>[0]): void {
  if (!request.mimeType.trim()) {
    throw new STTError('stt/invalid_request', 'STT mimeType must not be empty');
  }
  if (request.audio.byteLength === 0) {
    throw new STTError('stt/invalid_request', 'STT audio must not be empty');
  }
}

function validateResult(result: TranscriptionResult): void {
  for (const segment of result.segments ?? []) {
    if (
      !Number.isFinite(segment.startMs)
      || !Number.isFinite(segment.endMs)
      || segment.startMs < 0
      || segment.endMs < segment.startMs
      || typeof segment.text !== 'string'
    ) {
      throw new STTError('stt/invalid_response', 'STT provider returned malformed segment');
    }
  }
}
