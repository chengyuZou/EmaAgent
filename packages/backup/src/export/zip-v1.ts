import fs from 'node:fs';
import path from 'node:path';
import { strToU8, zipSync } from 'fflate';
import type { SessionExportResult, SessionExportSnapshot } from '../types.js';

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

function readBytes(filePath: string): Uint8Array {
  const buffer = fs.readFileSync(filePath);
  return new Uint8Array(buffer.buffer, buffer.byteOffset, buffer.byteLength);
}

/** ZIP v1 兼容导出器；同步内存压缩是已声明的 V1 边界。 */
export function exportSessionZipV1(
  snapshot: SessionExportSnapshot,
  artifactsEnabled: boolean,
): SessionExportResult {
  const files: Record<string, Uint8Array> = {};
  const putJson = (name: string, value: unknown): void => {
    files[name] = strToU8(JSON.stringify(value, null, 2));
  };

  putJson('manifest.json', {
    version: '1', exportedAt: Date.now(), sessionId: snapshot.session.id,
    generator: 'ema-agent-v1',
  });
  putJson('session.json', snapshot.session);
  putJson('turns.json', snapshot.turns);
  putJson('messages.json', snapshot.messages);
  putJson('branches.json', snapshot.branches);
  putJson('agent_tasks.json', snapshot.agentTasks);
  putJson('agent_task_messages.json', snapshot.agentTaskMessages);
  if (snapshot.memoryState) putJson('memory_state.json', snapshot.memoryState);
  if (snapshot.kbActivations.length > 0) putJson('kb_activations.json', snapshot.kbActivations);
  if (snapshot.llmTurnMetrics.length > 0) putJson('llm_turn_metrics.json', snapshot.llmTurnMetrics);

  if (artifactsEnabled) {
    putJson('artifacts/index.json', snapshot.artifacts.map((entry) => ({
      id: entry.id, type: entry.type, title: entry.title,
      contentLocation: entry.contentLocation, turnId: entry.turnId ?? null,
      createdAt: entry.createdAt, appliedAt: entry.appliedAt ?? null,
      rejectedAt: entry.rejectedAt ?? null,
    })));
    for (const artifact of snapshot.artifacts) {
      if (artifact.contentLocation === 'inline' && artifact.content) {
        files[`artifacts/${artifact.id}${artifactExt(artifact.type)}`] = strToU8(artifact.content);
      } else if (
        artifact.contentLocation === 'file'
        && artifact.contentPath
        && fs.existsSync(artifact.contentPath)
      ) {
        files[`artifacts/${artifact.id}${path.extname(artifact.contentPath) || '.bin'}`] = readBytes(artifact.contentPath);
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
    files[`audio/${entry.turn_id}${ext}`] = readBytes(entry.storage_path);
  }

  putJson('attachments/index.json', snapshot.attachments.map((entry) => ({
    id: entry.id, name: entry.name, mime: entry.mime, size: entry.size,
    turnId: entry.turnId, mtime: entry.mtime, createdAt: entry.createdAt,
  })));
  for (const attachment of snapshot.attachments) {
    if (!attachment.localPath || !fs.existsSync(attachment.localPath)) continue;
    const safeName = attachment.name.replace(/[/\\?%*:|"<>]/g, '_').slice(0, 80);
    files[`attachments/${attachment.id}_${safeName}`] = readBytes(attachment.localPath);
  }

  if (snapshot.notes) putJson('notes.json', snapshot.notes);
  const bytes = zipSync(files, { level: 6 });
  const safeTitle = (snapshot.session.title || 'session')
    .replace(/[^\w一-龥 -]/g, '').trim().slice(0, 30) || 'session';
  return {
    format: 'zip-v1',
    filename: `ema-${safeTitle}-${snapshot.session.id.slice(-6)}.zip`,
    mimeType: 'application/zip',
    bytes,
  };
}
