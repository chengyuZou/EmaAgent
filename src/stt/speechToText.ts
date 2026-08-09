// 创建一个绑定协议连接的语音转文字入口，并统一校验中立转录结果。
import { SttError } from './errors.js';
import { createOpenAiSttProtocol } from './protocols/openAi.js';
import type {
  SttConnection,
  TranscriptionRequest,
  TranscriptionResult,
} from './types.js';

export interface SpeechToText {
  readonly protocol: SttConnection['protocol'];
  transcribe(request: TranscriptionRequest): Promise<TranscriptionResult>;
}

/** STT 唯一创建入口；请求只执行一次，超时和重试由调用方通过 signal 控制。 */
export function createSpeechToText(connection: SttConnection): SpeechToText {
  const protocolTranscribe = createProtocolTranscribe(connection);
  return {
    protocol: connection.protocol,
    async transcribe(request) {
      validateRequest(request);
      const result = await protocolTranscribe(request);
      validateResult(result);
      return result;
    },
  };
}

function createProtocolTranscribe(
  connection: SttConnection,
): (request: TranscriptionRequest) => Promise<TranscriptionResult> {
  switch (connection.protocol) {
    case 'openai-stt': return createOpenAiSttProtocol(connection);
  }
}

function validateRequest(request: TranscriptionRequest): void {
  if (!request.model.trim()) {
    throw new SttError('stt/invalid_request', 'STT model must not be empty');
  }
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
