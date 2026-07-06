import fs   from 'node:fs';
import path from 'node:path';

// ── TTS audio archive ───────────────────────────────────────────────────────
//
// Persists streamed audio chunks to disk under a per-session directory:
//   {sessionsRoot}/{sessionId}/audio/segments/{turnId}/{sentenceIndex}.{ext}
//   {sessionsRoot}/{sessionId}/audio/merged/{turnId}.{ext}
//
// Per-session layout means an entire session's audio is collocated with its
// artifacts/scratchpad, so `removeSessionDir` cleans everything in one call.
//
// Merge strategy:
//   - If all chunks are MP3: concat after stripping ID3 tags from each
//     (borrowed from v0.4 prototype — works without external tools)
//   - Else: write only the first segment as the merged file (degraded path)

export interface FinalizedAudio {
  path:          string;
  mime:          string;
  byteSize:      number;
  durationMs:    number | null;
  segmentCount:  number;
}

export interface AudioArchive {
  /** Open a new segment writer. Returns a sink the caller pushes bytes to. */
  openSegment(sessionId: string, turnId: string, sentenceIndex: number, ext: string): SegmentWriter;

  /** Finalize a turn: merge all segments into one file and return its path + metadata. */
  finalizeTurn(sessionId: string, turnId: string, ext: string): Promise<FinalizedAudio | null>;

  /** Forget a turn's audio (called on turn_aborted / turn_failed). */
  discardTurn(sessionId: string, turnId: string): void;

  /**
   * Look up the merged audio for a turn, regardless of extension. Returns
   * { path, mime } for the route handler to stream, or null if no merged
   * file exists yet (turn aborted before finalize, or no TTS happened).
   */
  findMergedFor(sessionId: string, turnId: string): { path: string; mime: string } | null;
}

export interface SegmentWriter {
  write(bytes: Uint8Array): void;
  close(): string; // returns the written file path
}

// ── Filesystem-backed implementation ────────────────────────────────────────

/**
 * @param sessionsRoot The `{dataDir}/sessions` root. Per-session audio lives
 *                     under `{sessionsRoot}/{sessionId}/audio/`.
 */
export class FsAudioArchive implements AudioArchive {
  constructor(private readonly sessionsRoot: string) {}

  private audioDir(sessionId: string): string {
    return path.join(this.sessionsRoot, sessionId, 'audio');
  }

  openSegment(sessionId: string, turnId: string, sentenceIndex: number, ext: string): SegmentWriter {
    const dir = path.join(this.audioDir(sessionId), 'segments', turnId);
    fs.mkdirSync(dir, { recursive: true });
    const filePath = path.join(dir, `${sentenceIndex}.${ext}`);
    const fd = fs.openSync(filePath, 'w');

    return {
      write(bytes) { fs.writeSync(fd, bytes); },
      close() { fs.closeSync(fd); return filePath; },
    };
  }

  async finalizeTurn(sessionId: string, turnId: string, ext: string): Promise<FinalizedAudio | null> {
    const audioDir = this.audioDir(sessionId);
    const segDir = path.join(audioDir, 'segments', turnId);
    if (!fs.existsSync(segDir)) return null;

    const segments = fs.readdirSync(segDir)
      .filter((f) => f.endsWith('.' + ext))
      .sort(byNumericPrefix)
      .map((f) => path.join(segDir, f));

    if (segments.length === 0) return null;

    const mergedDir = path.join(audioDir, 'merged');
    fs.mkdirSync(mergedDir, { recursive: true });
    const target = path.join(mergedDir, `${turnId}.${ext}`);

    let bytes: Buffer;
    if (segments.length === 1) {
      bytes = fs.readFileSync(segments[0]!);
    } else if (ext === 'mp3') {
      const merged = mergeMp3SegmentsByConcat(segments);
      bytes = merged ?? fs.readFileSync(segments[0]!);
    } else {
      // Degraded fallback: only first segment survives
      bytes = fs.readFileSync(segments[0]!);
    }
    fs.writeFileSync(target, bytes);

    return {
      path:         target,
      mime:         mimeForExt(ext),
      byteSize:     bytes.length,
      durationMs:   estimateAudioDurationMs(bytes, ext),
      segmentCount: segments.length,
    };
  }

  discardTurn(sessionId: string, turnId: string): void {
    const audioDir = this.audioDir(sessionId);
    const segDir = path.join(audioDir, 'segments', turnId);
    if (fs.existsSync(segDir)) fs.rmSync(segDir, { recursive: true, force: true });
    const merged = path.join(audioDir, 'merged');
    if (fs.existsSync(merged)) {
      for (const f of fs.readdirSync(merged)) {
        if (f.startsWith(turnId + '.')) fs.rmSync(path.join(merged, f), { force: true });
      }
    }
  }

  findMergedFor(sessionId: string, turnId: string): { path: string; mime: string } | null {
    const dir = path.join(this.audioDir(sessionId), 'merged');
    if (!fs.existsSync(dir)) return null;
    for (const f of fs.readdirSync(dir)) {
      if (!f.startsWith(turnId + '.')) continue;
      const ext = path.extname(f).slice(1).toLowerCase();
      return { path: path.join(dir, f), mime: mimeForExt(ext) };
    }
    return null;
  }
}

function mimeForExt(ext: string): string {
  switch (ext) {
    case 'mp3':  return 'audio/mpeg';
    case 'wav':  return 'audio/wav';
    case 'ogg':
    case 'opus': return 'audio/ogg';
    case 'pcm':  return 'audio/L16';
    case 'aac':  return 'audio/aac';
    default:     return 'application/octet-stream';
  }
}

/**
 * Best-effort duration estimate from the byte stream. Exact for WAV (header),
 * approximate for MP3 (frame count × frame duration). Returns null when the
 * format is unknown — the caller treats null as "duration unknown" rather
 * than 0, so downstream stats stay honest.
 */
function estimateAudioDurationMs(bytes: Buffer, ext: string): number | null {
  if (ext === 'wav' && bytes.length >= 44) {
    // RIFF header: sample rate at offset 24 (4 bytes LE), byte rate at 28.
    const byteRate = bytes.readUInt32LE(28);
    if (byteRate > 0) return Math.round((bytes.length / byteRate) * 1000);
  }
  if (ext === 'mp3') {
    // Count audio frames; each frame's duration = 1152 samples / sample_rate.
    // CBR approximation — good enough for a stat field.
    const sampleRate = extractMp3SampleRate(bytes);
    if (sampleRate > 0) {
      const frames = countMp3Frames(bytes);
      if (frames > 0) return Math.round((frames * 1152 * 1000) / sampleRate);
    }
  }
  return null;
}

function extractMp3SampleRate(data: Buffer): number {
  const RATES = [44100, 48000, 32000, 0]; // index 0..3 by bitrate bits
  // Find first valid frame header (sync 0xFFE/0xFFE0)
  for (let i = 0; i < data.length - 4; i++) {
    if (data[i] === 0xFF && (data[i + 1]! & 0xE0) === 0xE0) {
      const srBits = (data[i + 2]! >> 2) & 0x03;
      const rate = RATES[srBits];
      if (rate && rate > 0) return rate;
    }
  }
  return 0;
}

function countMp3Frames(data: Buffer): number {
  let count = 0;
  for (let i = 0; i < data.length - 4; i++) {
    if (data[i] === 0xFF && (data[i + 1]! & 0xE0) === 0xE0) {
      count++;
      // Skip past this frame (frame length varies; advance ~417 bytes for 128kbps/44.1kHz)
      i += 416;
    }
  }
  return count;
}

// ── MP3 concat helpers (no ffmpeg) ──────────────────────────────────────────
//
// Adapted from v0.4 prototype tts_service.py. Strips ID3v2 header + ID3v1
// trailer from each file so the merged stream is a clean sequence of frames.

function mergeMp3SegmentsByConcat(filePaths: string[]): Buffer | null {
  const chunks: Buffer[] = [];
  for (const fp of filePaths) {
    try {
      const raw = fs.readFileSync(fp);
      const stripped = stripMp3Id3Tags(raw);
      if (stripped.length > 0) chunks.push(stripped);
    } catch {
      // Skip unreadable files
    }
  }
  if (chunks.length === 0) return null;
  return Buffer.concat(chunks);
}

function stripMp3Id3Tags(data: Buffer): Buffer {
  let payload = data;

  // ID3v2 header at start: "ID3" + version(2) + flags(1) + synchsafe size(4)
  if (payload.length >= 10 && payload.slice(0, 3).toString('ascii') === 'ID3') {
    const s0 = payload[6]! & 0x7f;
    const s1 = payload[7]! & 0x7f;
    const s2 = payload[8]! & 0x7f;
    const s3 = payload[9]! & 0x7f;
    const tagSize = (s0 << 21) | (s1 << 14) | (s2 << 7) | s3;
    let headerSize = 10 + tagSize;
    if ((payload[5]! & 0x10) !== 0) headerSize += 10; // footer flag
    if (headerSize < payload.length) {
      payload = payload.subarray(headerSize);
    } else {
      return Buffer.alloc(0);
    }
  }

  // ID3v1 trailer: 128 bytes starting "TAG"
  if (payload.length >= 128 && payload.slice(-128, -125).toString('ascii') === 'TAG') {
    payload = payload.subarray(0, payload.length - 128);
  }

  return payload;
}

function byNumericPrefix(a: string, b: string): number {
  const na = parseInt(a, 10);
  const nb = parseInt(b, 10);
  if (Number.isFinite(na) && Number.isFinite(nb)) return na - nb;
  return a.localeCompare(b);
}
