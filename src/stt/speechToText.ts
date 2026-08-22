// 创建点冻结连接与模型身份的语音转文字调用，并统一校验中立转录结果。
import { SttError } from './errors.js';
import { createOpenAiSttProtocol } from './protocols/openAi.js';
import type {
  CallStt,
  SttConnection,
  TranscriptionResult,
} from './types.js';

/** STT 唯一创建入口；modelId 在此冻结，此后每次调用只携带音频与取消信号。 */
export function createSttCall(connection: SttConnection, modelId: string): CallStt {
  if (!modelId.trim()) throw new SttError('stt/invalid_request', 'STT model must not be empty');
  const protocolTranscribe = createProtocolTranscribe(connection, modelId);
  return async (request) => {
    validateRequest(request);
    const result = await protocolTranscribe(request);
    validateResult(result);
    return result;
  };
}

function createProtocolTranscribe(
  connection: SttConnection,
  modelId: string,
): CallStt {
  switch (connection.protocol) {
    case 'openai-stt': return createOpenAiSttProtocol(connection, modelId);
  }
}

function validateRequest(request: Parameters<CallStt>[0]): void {
  if (!request.mimeType.trim()) {
    throw new SttError('stt/invalid_request', 'STT mimeType must not be empty');
  }
  if (request.audio.byteLength === 0) {
    throw new SttError('stt/invalid_request', 'STT audio must not be empty');
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
      throw new SttError('stt/invalid_response', 'STT provider returned malformed segment');
    }
  }
}
