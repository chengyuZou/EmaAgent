import fs from 'node:fs';
import { CharacterResourceValidationError } from '../errors.js';
import {
  MAX_CHARACTER_VOICE_BYTES,
  MAX_CHARACTER_VOICE_DURATION_MS,
} from './limits.js';

export interface ValidatedVoiceSample {
  readonly mimeType: 'audio/wav' | 'audio/mpeg' | 'audio/flac' | 'audio/ogg' | 'audio/mp4';
  readonly byteSize: number;
  readonly durationMs: number;
}

export async function validateVoiceSampleFile(
  filePath: string,
): Promise<ValidatedVoiceSample> {
  const stat = await fs.promises.lstat(filePath);
  if (!stat.isFile() || stat.isSymbolicLink()) {
    throw new CharacterResourceValidationError('source_file_required');
  }
  if (stat.size <= 0) {
    throw new CharacterResourceValidationError('invalid_resource_values');
  }
  if (stat.size > MAX_CHARACTER_VOICE_BYTES) {
    throw new CharacterResourceValidationError('resource_too_large');
  }
  const head = await readRange(filePath, 0, Math.min(stat.size, 1024 * 1024));
  const detected = detectAudio(head, stat.size, filePath);
  if (
    !Number.isFinite(detected.durationMs)
    || detected.durationMs <= 0
    || detected.durationMs > MAX_CHARACTER_VOICE_DURATION_MS
  ) {
    throw new CharacterResourceValidationError('voice_duration_invalid');
  }
  return {
    ...detected,
    byteSize: stat.size,
  };
}

function detectAudio(
  head: Buffer,
  byteSize: number,
  filePath: string,
): Omit<ValidatedVoiceSample, 'byteSize'> {
  if (head.subarray(0, 4).toString('ascii') === 'RIFF'
    && head.subarray(8, 12).toString('ascii') === 'WAVE') {
    return {
      mimeType: 'audio/wav',
      durationMs: wavDuration(head),
    };
  }
  if (head.subarray(0, 4).toString('ascii') === 'fLaC') {
    return {
      mimeType: 'audio/flac',
      durationMs: flacDuration(head),
    };
  }
  if (head.subarray(0, 4).toString('ascii') === 'OggS') {
    return {
      mimeType: 'audio/ogg',
      durationMs: oggDuration(head, filePath, byteSize),
    };
  }
  if (head.subarray(4, 8).toString('ascii') === 'ftyp') {
    return {
      mimeType: 'audio/mp4',
      durationMs: mp4Duration(head),
    };
  }
  const frameOffset = findMp3Frame(head);
  if (frameOffset >= 0) {
    return {
      mimeType: 'audio/mpeg',
      durationMs: mp3Duration(head, frameOffset, byteSize),
    };
  }
  throw new CharacterResourceValidationError('voice_format_unsupported');
}

function wavDuration(buffer: Buffer): number {
  let offset = 12;
  let byteRate = 0;
  let dataBytes = 0;
  while (offset + 8 <= buffer.length) {
    const id = buffer.subarray(offset, offset + 4).toString('ascii');
    const size = buffer.readUInt32LE(offset + 4);
    if (id === 'fmt ' && offset + 20 <= buffer.length) {
      byteRate = buffer.readUInt32LE(offset + 16);
    } else if (id === 'data') {
      dataBytes = size;
      break;
    }
    offset += 8 + size + (size % 2);
  }
  return byteRate > 0 ? (dataBytes / byteRate) * 1000 : 0;
}

function flacDuration(buffer: Buffer): number {
  if (buffer.length < 42 || (buffer[4]! & 0x7f) !== 0) return 0;
  const sampleRate = (buffer[18]! << 12) | (buffer[19]! << 4) | (buffer[20]! >> 4);
  const totalSamples = (
    (BigInt(buffer[21]! & 0x0f) << 32n)
    | BigInt(buffer.readUInt32BE(22))
  );
  return sampleRate > 0 ? Number(totalSamples) / sampleRate * 1000 : 0;
}

function oggDuration(head: Buffer, filePath: string, byteSize: number): number {
  const opus = head.includes(Buffer.from('OpusHead'));
  const vorbisOffset = head.indexOf(Buffer.from('\x01vorbis', 'binary'));
  const sampleRate = opus
    ? 48_000
    : vorbisOffset >= 0 && vorbisOffset + 16 <= head.length
      ? head.readUInt32LE(vorbisOffset + 12)
      : 0;
  if (sampleRate <= 0) return 0;
  const tailSize = Math.min(byteSize, 128 * 1024);
  const descriptor = fs.openSync(filePath, 'r');
  const tail = Buffer.allocUnsafe(tailSize);
  try {
    fs.readSync(descriptor, tail, 0, tailSize, byteSize - tailSize);
  } finally {
    fs.closeSync(descriptor);
  }
  let offset = tail.lastIndexOf(Buffer.from('OggS'));
  while (offset >= 0 && offset + 14 > tail.length) {
    offset = tail.lastIndexOf(Buffer.from('OggS'), offset - 1);
  }
  if (offset < 0) return 0;
  const granule = tail.readBigUInt64LE(offset + 6);
  return Number(granule) / sampleRate * 1000;
}

function mp4Duration(buffer: Buffer): number {
  const marker = buffer.indexOf(Buffer.from('mvhd'));
  if (marker < 4 || marker + 24 > buffer.length) return 0;
  const version = buffer[marker + 4];
  if (version === 0) {
    const timescale = buffer.readUInt32BE(marker + 16);
    const duration = buffer.readUInt32BE(marker + 20);
    return timescale > 0 ? duration / timescale * 1000 : 0;
  }
  if (version === 1 && marker + 36 <= buffer.length) {
    const timescale = buffer.readUInt32BE(marker + 28);
    const duration = buffer.readBigUInt64BE(marker + 32);
    return timescale > 0 ? Number(duration) / timescale * 1000 : 0;
  }
  return 0;
}

function findMp3Frame(buffer: Buffer): number {
  const start = buffer.subarray(0, 3).toString('ascii') === 'ID3' && buffer.length >= 10
    ? 10 + synchsafe(buffer.subarray(6, 10))
    : 0;
  for (let index = start; index + 4 <= buffer.length; index += 1) {
    if (buffer[index] === 0xff && (buffer[index + 1]! & 0xe0) === 0xe0) return index;
  }
  return -1;
}

function mp3Duration(buffer: Buffer, offset: number, byteSize: number): number {
  const second = buffer[offset + 1]!;
  const third = buffer[offset + 2]!;
  const versionBits = (second >> 3) & 0x03;
  const layerBits = (second >> 1) & 0x03;
  const bitrateIndex = (third >> 4) & 0x0f;
  if (layerBits !== 1 || bitrateIndex === 0 || bitrateIndex === 15) return 0;
  const mpeg1 = versionBits === 3;
  const rates = mpeg1
    ? [0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320]
    : [0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160];
  const bitrateKbps = rates[bitrateIndex] ?? 0;
  return bitrateKbps > 0 ? byteSize * 8 / (bitrateKbps * 1000) * 1000 : 0;
}

function synchsafe(value: Buffer): number {
  return ((value[0]! & 0x7f) << 21)
    | ((value[1]! & 0x7f) << 14)
    | ((value[2]! & 0x7f) << 7)
    | (value[3]! & 0x7f);
}

async function readRange(filePath: string, offset: number, length: number): Promise<Buffer> {
  const descriptor = await fs.promises.open(filePath, 'r');
  try {
    const buffer = Buffer.allocUnsafe(length);
    const { bytesRead } = await descriptor.read(buffer, 0, length, offset);
    return buffer.subarray(0, bytesRead);
  } finally {
    await descriptor.close();
  }
}
