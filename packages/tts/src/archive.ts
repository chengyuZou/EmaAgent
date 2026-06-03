import fs   from 'node:fs';
import path from 'node:path';

// ── TTS audio archive ───────────────────────────────────────────────────────
//
// Persists streamed audio chunks to disk. Two layers:
//   1. Per-sentence segment files: one file per `sentence_done`, written to
//      `{audioRoot}/segments/{turnId}/{sentenceIndex}.{ext}`
//   2. Per-turn merged file: written after all sentences complete, at
//      `{audioRoot}/merged/{turnId}.{ext}`
//
// Merge strategy:
//   - If `ffmpeg` available: use it (cleanest; future enhancement)
//   - Else if all chunks are MP3: concat after stripping ID3 tags from each
//     (borrowed from v0.4 prototype — works without external tools)
//   - Else: write only the first segment as the merged file (degraded path)

export interface AudioArchive {
  /** Open a new segment writer. Returns a sink the caller pushes bytes to. */
  openSegment(turnId: string, sentenceIndex: number, ext: string): SegmentWriter;

  /** Finalize a turn: merge all segments into one file and return its path. */
  finalizeTurn(turnId: string, ext: string): Promise<string | null>;

  /** Forget a turn's audio (called on turn_aborted / turn_failed). */
  discardTurn(turnId: string): void;

  /**
   * Look up the merged audio for a turn, regardless of extension. Returns
   * { path, mime } for the route handler to stream, or null if no merged
   * file exists yet (turn aborted before finalize, or no TTS happened).
   */
  findMergedFor(turnId: string): { path: string; mime: string } | null;
}

export interface SegmentWriter {
  write(bytes: Uint8Array): void;
  close(): string; // returns the written file path
}

// ── Filesystem-backed implementation ────────────────────────────────────────

export class FsAudioArchive implements AudioArchive {
  constructor(private readonly audioRoot: string) {
    fs.mkdirSync(path.join(this.audioRoot, 'segments'), { recursive: true });
    fs.mkdirSync(path.join(this.audioRoot, 'merged'),   { recursive: true });
  }

  openSegment(turnId: string, sentenceIndex: number, ext: string): SegmentWriter {
    const dir = path.join(this.audioRoot, 'segments', turnId);
    fs.mkdirSync(dir, { recursive: true });
    const filePath = path.join(dir, `${sentenceIndex}.${ext}`);
    const fd = fs.openSync(filePath, 'w');

    return {
      write(bytes) { fs.writeSync(fd, bytes); },
      close() { fs.closeSync(fd); return filePath; },
    };
  }

  async finalizeTurn(turnId: string, ext: string): Promise<string | null> {
    const segDir = path.join(this.audioRoot, 'segments', turnId);
    if (!fs.existsSync(segDir)) return null;

    const segments = fs.readdirSync(segDir)
      .filter((f) => f.endsWith('.' + ext))
      .sort(byNumericPrefix)
      .map((f) => path.join(segDir, f));

    if (segments.length === 0) return null;

    const target = path.join(this.audioRoot, 'merged', `${turnId}.${ext}`);

    if (segments.length === 1) {
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.copyFileSync(segments[0]!, target);
      return target;
    }

    if (ext === 'mp3') {
      const merged = mergeMp3SegmentsByConcat(segments);
      if (merged) {
        fs.writeFileSync(target, merged);
        return target;
      }
    }

    // Degraded fallback: only first segment survives
    fs.copyFileSync(segments[0]!, target);
    return target;
  }

  discardTurn(turnId: string): void {
    const segDir = path.join(this.audioRoot, 'segments', turnId);
    if (fs.existsSync(segDir)) fs.rmSync(segDir, { recursive: true, force: true });
    const merged = path.join(this.audioRoot, 'merged');
    if (fs.existsSync(merged)) {
      for (const f of fs.readdirSync(merged)) {
        if (f.startsWith(turnId + '.')) fs.rmSync(path.join(merged, f), { force: true });
      }
    }
  }

  findMergedFor(turnId: string): { path: string; mime: string } | null {
    const dir = path.join(this.audioRoot, 'merged');
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
