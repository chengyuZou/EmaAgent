// 按安全预算把单个 Session 导出为 ZIP v1 归档。
import fs from 'node:fs';
import path from 'node:path';
import { strToU8, zipSync } from 'fflate';
import type { SessionExportResult, SessionExportSnapshot } from '../types.js';

const MiB = 1024 * 1024;

export interface SessionExportLimits {
  readonly maxEntryBytes: number;
  readonly maxExpandedBytes: number;
  readonly maxArchiveBytes: number;
}

/** ZIP v1 是同步内存格式；先给出明确上限，超大备份留给后续流式 ZIP v2。 */
export const SESSION_EXPORT_LIMITS: Readonly<SessionExportLimits> = Object.freeze({
  maxEntryBytes: 64 * MiB,
  maxExpandedBytes: 128 * MiB,
  maxArchiveBytes: 160 * MiB,
});

export class SessionExportError extends Error {
  readonly code = 'export_too_large';
  readonly status = 413;

  constructor(message: string) {
    super(message);
    this.name = 'SessionExportError';
  }
}

function validateExportLimits(limits: Readonly<SessionExportLimits>): void {
  for (const [name, value] of Object.entries(limits)) {
    if (!Number.isSafeInteger(value) || value <= 0) {
      throw new TypeError(`Session export ${name} must be a positive safe integer`);
    }
  }
  if (limits.maxEntryBytes > limits.maxExpandedBytes) {
    throw new TypeError('Session export maxEntryBytes cannot exceed maxExpandedBytes');
  }
}

function artifactExt(type: string): string {
  const extensions: Record<string, string> = {
    code: '.txt', markdown: '.md', diff: '.diff', image: '.bin',
    json: '.json', html: '.html', svg: '.svg',
  };
  return extensions[type] ?? '.txt';
}

function mimeToExt(mime: string): string {
  if (mime.includes('mp3') || mime.includes('mpeg')) return '.mp3';
  if (mime.includes('ogg')) return '.ogg';
  if (mime.includes('wav')) return '.wav';
  if (mime.includes('flac')) return '.flac';
  return '.mp3';
}

/** ZIP v1 兼容导出器；同步内存压缩是已声明的 V1 边界。 */
export function exportSessionZipV1(
  snapshot: SessionExportSnapshot,
  artifactsEnabled: boolean,
  limits: Readonly<SessionExportLimits> = SESSION_EXPORT_LIMITS,
): SessionExportResult {
  validateExportLimits(limits);
  const files: Record<string, Uint8Array> = {};
  let expandedBytes = 0;

  const putBytes = (name: string, bytes: Uint8Array): void => {
    if (bytes.byteLength > limits.maxEntryBytes) {
      throw new SessionExportError(`备份条目 ${name} 超过 ${limits.maxEntryBytes} 字节限制`);
    }
    if (expandedBytes + bytes.byteLength > limits.maxExpandedBytes) {
      throw new SessionExportError(`Session 备份内容超过 ${limits.maxExpandedBytes} 字节限制`);
    }
    expandedBytes += bytes.byteLength;
    files[name] = bytes;
  };

  const putFile = (name: string, filePath: string): void => {
    const size = fs.statSync(filePath).size;
    if (size > limits.maxEntryBytes || expandedBytes + size > limits.maxExpandedBytes) {
      throw new SessionExportError(`Session 文件 ${name} 超过 ZIP v1 安全预算`);
    }
    const buffer = fs.readFileSync(filePath);
    putBytes(name, new Uint8Array(buffer.buffer, buffer.byteOffset, buffer.byteLength));
  };

  const putJson = (name: string, value: unknown): void => {
    putBytes(name, strToU8(JSON.stringify(value, null, 2)));
  };

  putJson('manifest.json', {
    version: '1', exportedAt: Date.now(), sessionId: snapshot.session.id,
    generator: 'ema-agent-v1',
  });
  putJson('session.json', snapshot.session);
  putJson('turns.json', snapshot.turns);
  putJson('messages.json', snapshot.messages);
  putJson('branches.json', snapshot.branches);
  putJson('agent_runs.json', snapshot.agentRuns);
  putJson('agent_run_messages.json', snapshot.agentRunMessages);
  if (snapshot.memoryState) putJson('memory_state.json', snapshot.memoryState);
  if (snapshot.kbActivations.length > 0) putJson('kb_activations.json', snapshot.kbActivations);
  if (snapshot.usageRecords.length > 0) putJson('usage_records.json', snapshot.usageRecords);

  if (artifactsEnabled) {
    putJson('artifacts/index.json', snapshot.artifacts.map((entry) => ({
      id: entry.id, type: entry.type, title: entry.title,
      contentLocation: entry.contentLocation, turnId: entry.turnId ?? null,
      createdAt: entry.createdAt, appliedAt: entry.appliedAt ?? null,
      rejectedAt: entry.rejectedAt ?? null,
    })));
    for (const artifact of snapshot.artifacts) {
      if (artifact.contentLocation === 'inline' && artifact.content) {
        putBytes(
          `artifacts/${artifact.id}${artifactExt(artifact.type)}`,
          strToU8(artifact.content),
        );
      } else if (
        artifact.contentLocation === 'file'
        && artifact.contentPath
        && fs.existsSync(artifact.contentPath)
      ) {
        putFile(
          `artifacts/${artifact.id}${path.extname(artifact.contentPath) || '.bin'}`,
          artifact.contentPath,
        );
      }
    }
  }

  putJson('audio/index.json', snapshot.audio.map((entry) => ({
    turnId: entry.turn_id, mimeType: entry.mime_type, byteSize: entry.byte_size,
    durationMs: entry.duration_ms, segmentCount: entry.segment_count,
    createdAt: entry.created_at,
  })));
  for (const entry of snapshot.audio) {
    if (!entry.storage_path || !fs.existsSync(entry.storage_path)) continue;
    const ext = path.extname(entry.storage_path) || mimeToExt(entry.mime_type);
    putFile(`audio/${entry.turn_id}${ext}`, entry.storage_path);
  }

  putJson('attachments/index.json', snapshot.attachments.map((entry) => ({
    id: entry.id, name: entry.name, mime: entry.mime, size: entry.size,
    turnId: entry.turnId, mtime: entry.mtime, createdAt: entry.createdAt,
  })));
  for (const attachment of snapshot.attachments) {
    if (!attachment.localPath || !fs.existsSync(attachment.localPath)) continue;
    const safeName = attachment.name.replace(/[/\\?%*:|"<>]/g, '_').slice(0, 80);
    putFile(`attachments/${attachment.id}_${safeName}`, attachment.localPath);
  }

  if (snapshot.notes) putJson('notes.json', snapshot.notes);
  const bytes = zipSync(files, { level: 6 });
  if (bytes.byteLength > limits.maxArchiveBytes) {
    throw new SessionExportError(`Session ZIP 超过 ${limits.maxArchiveBytes} 字节限制`);
  }
  const safeTitle = (snapshot.session.title || 'session')
    .replace(/[^\w一-龥 -]/g, '').trim().slice(0, 30) || 'session';
  return {
    format: 'zip-v1',
    filename: `ema-${safeTitle}-${snapshot.session.id.slice(-6)}.zip`,
    mimeType: 'application/zip',
    bytes,
  };
}
