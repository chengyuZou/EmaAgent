import { TtsError } from '../errors.js';
import type { PcmAudioFormat, TtsStreamEvent } from '../types.js';

export const PCM_SAMPLE_BYTES = 2;
const PCM_CHUNK_BYTES = 8 * 1024;

/** 网络块可以切在采样中间, 对外只交付完整的 PCM16LE 帧. */
export async function* pcmEvents(
  source: AsyncIterable<Uint8Array>,
  format: PcmAudioFormat,
  startedAt: number,
): AsyncGenerator<TtsStreamEvent> {
  yield { type: 'audio_started', sampleRate: format.sampleRate, channelCount: format.channelCount };
  const frameBytes = format.channelCount * PCM_SAMPLE_BYTES;
  const chunkBytes = PCM_CHUNK_BYTES - PCM_CHUNK_BYTES % frameBytes;
  let tail: Uint8Array = new Uint8Array(0);
  let totalBytes = 0;
  let firstByteMs: number | undefined;
  for await (const incoming of source) {
    if (incoming.byteLength === 0) {
      continue;
    }
    firstByteMs ??= Date.now() - startedAt;
    let bytes = incoming;
    if (tail.byteLength > 0) {
      bytes = Buffer.concat([tail, incoming]);
    }
    const alignedLength = bytes.byteLength - bytes.byteLength % frameBytes;
    for (let offset = 0; offset < alignedLength; offset += chunkBytes) {
      const chunk = bytes.subarray(offset, Math.min(offset + chunkBytes, alignedLength));
      totalBytes += chunk.byteLength;
      yield { type: 'audio_chunk', bytes: chunk };
    }
    // 只保留不足一帧的字节. 复制这几个字节, 避免为了残帧一直占着整个网络块的内存.
    tail = Uint8Array.from(bytes.subarray(alignedLength));
  }
  if (tail.byteLength > 0) {
    throw new TtsError('tts/invalid_response', 'TTS PCM ended with an incomplete sample');
  }
  yield { type: 'done', totalBytes, firstByteMs: firstByteMs ?? 0 };
}
