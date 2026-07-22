// 编排 Session 备份导入导出，并统一处理校验、文件落盘和事务恢复。
import fs from 'node:fs';
import path from 'node:path';
import {
  SessionRestoreValidationError,
  type ArtifactRestoreRow,
  type AttachmentRestoreRow,
  type AudioRestoreRow,
  type MessageRestoreRow,
  type SessionRestorePayload,
  type TurnRestoreRow,
} from '@ema-agent/storage';
import { extractSessionArchive, SESSION_IMPORT_LIMITS } from './import/archive.js';
import { SessionImportError } from './import/errors.js';
import { SessionImportFileCommit } from './import/file-commit.js';
import { assertPortableImportId } from './import/path-policy.js';
import type {
  BackupArchiveSource,
  SessionBackupCapabilities,
  SessionBackupPorts,
  SessionImportRequest,
  SessionImportResult,
  SessionExportRequest,
  SessionExportResult,
  ImportWarningWire,
} from './types.js';
import { exportSessionZipV1 } from './export/zip-v1.js';

const CAPABILITIES: SessionBackupCapabilities = Object.freeze({
  importFormats: Object.freeze(['zip-v1'] as const),
  exportFormats: Object.freeze(['zip-v1'] as const),
  // 输入端口已经分块，但 ZIP v1 解压器仍需在硬上限内聚合压缩数据。
  streamingArchiveInput: false,
  streamingArchiveOutput: false,
  streamingJsonRecords: false,
  multipartVolumes: false,
  integrityManifest: false,
});

interface Manifest { version: string; }
interface SessionExport {
  id: string; title: string; workspaceRoot: string | null;
  createdAt: number; updatedAt: number; lastActivityAt: number;
  archivedAt: number | null; pinned: boolean; pinnedAt: number | null;
  groupLabel: string | null; parentSessionId: string | null;
  executionProfile: 'chat' | 'work';
  narrativePolicy: 'auto' | 'always' | 'off';
  activeBranchId: string | null;
  preferredProviderConfigId?: string | null;
  preferredModelId?: string | null;
}
interface AudioMeta {
  turnId: string; mimeType: string; byteSize: number; durationMs: number | null;
  segmentCount: number; createdAt: number;
}
interface AttachmentMeta {
  id: string; name: string; mime: string; size: number; turnId: string;
  mtime: number; createdAt: number;
}
interface ArtifactMeta {
  id: string; type: string; title: string; contentLocation: string;
  turnId: string | null; createdAt: number; appliedAt: number | null;
  rejectedAt: number | null;
}
interface BranchExport {
  id: string; parent_branch_id: string | null;
  fork_from_turn_id: string | null; created_at: number;
}
interface NotesExport { body: string; tokensAtLastUpdate: number; updatedAt: number; }

/** Session 备份唯一业务入口；Core/CLI 不得绕过它直接解压或恢复行。 */
export class SessionBackupFacade {
  constructor(private readonly ports: SessionBackupPorts) {}

  capabilities(): SessionBackupCapabilities {
    return CAPABILITIES;
  }

  exportSession(request: SessionExportRequest): SessionExportResult | null {
    const snapshot = this.ports.collectExport(request.sessionId);
    return snapshot ? exportSessionZipV1(snapshot, this.ports.artifactsEnabled) : null;
  }

  async importSession(request: SessionImportRequest): Promise<SessionImportResult> {
    if (request.format !== undefined && request.format !== 'auto' && request.format !== 'zip-v1') {
      throw new SessionImportError('invalid_format', `不支持备份格式 ${String(request.format)}`);
    }

    const bytes = await readBoundedSource(request.source, request.signal);
    const extracted = extractSessionArchive(
      bytes,
      path.join(this.ports.activeDataDir, '.imports'),
    );
    let fileCommit: SessionImportFileCommit | null = null;

    try {
      const manifest = extracted.readJson<Manifest>('manifest.json', true)!;
      if (manifest.version !== '1') {
        throw new SessionImportError('unsupported_version', `不支持备份版本 ${String(manifest.version)}`);
      }

      const session = extracted.readJson<SessionExport>('session.json', true)!;
      assertPortableImportId(session.id, 'Session id');
      if (this.ports.sessionExists(session.id)) {
        throw new SessionImportError('destination_conflict', `会话 ${session.id} 已存在，请先删除后再导入`, 409);
      }

      fileCommit = new SessionImportFileCommit(this.ports.activeDataDir, session.id);
      const audio = this.restoreAudio(extracted, fileCommit, session.id);
      const attachments = this.restoreAttachments(extracted, fileCommit);
      const warnings: ImportWarningWire[] = [];
      const artifacts = this.restoreArtifacts(extracted, fileCommit, session.id, warnings);
      const payload = this.buildPayload(extracted, session, { audio, attachments, artifacts });

      try {
        this.ports.restoreRows(payload);
      } catch (error) {
        if (error instanceof SessionRestoreValidationError) {
          throw new SessionImportError('invalid_format', error.message);
        }
        throw error;
      }
      fileCommit.commit();

      return { sessionId: session.id, format: 'zip-v1', warnings };
    } catch (error) {
      fileCommit?.rollback();
      throw error;
    } finally {
      extracted.dispose();
    }
  }

  private restoreAudio(
    extracted: ReturnType<typeof extractSessionArchive>,
    files: SessionImportFileCommit,
    sessionId: string,
  ): AudioRestoreRow[] {
    const index = extracted.readJson<AudioMeta[]>('audio/index.json') ?? [];
    assertArray(index, 'audio/index.json');
    return index.map((entry) => {
      assertPortableImportId(entry.turnId, 'Audio turnId');
      const ext = mimeToExt(entry.mimeType);
      const source = requireArchiveFile(extracted, `audio/${entry.turnId}${ext}`);
      const destination = files.copyToSession(source, 'audio', 'merged', `${entry.turnId}${ext}`);
      const actualSize = fs.statSync(destination).size;
      if (actualSize !== entry.byteSize) {
        throw new SessionImportError('invalid_format', `音频大小不匹配: ${entry.turnId}`);
      }
      return {
        turnId: entry.turnId, sessionId, storagePath: destination,
        mimeType: entry.mimeType, byteSize: actualSize,
        durationMs: entry.durationMs, segmentCount: entry.segmentCount,
        createdAt: entry.createdAt,
      };
    });
  }

  private restoreAttachments(
    extracted: ReturnType<typeof extractSessionArchive>,
    files: SessionImportFileCommit,
  ): AttachmentRestoreRow[] {
    const index = extracted.readJson<AttachmentMeta[]>('attachments/index.json') ?? [];
    assertArray(index, 'attachments/index.json');
    return index.map((entry) => {
      assertPortableImportId(entry.id, 'Attachment id');
      assertPortableImportId(entry.turnId, 'Attachment turnId');
      const safeName = safeImportedFileName(entry.name);
      const source = requireArchiveFile(extracted, `attachments/${entry.id}_${safeName}`);
      const destination = files.copyAttachment(source, entry.id, safeName);
      const actualSize = fs.statSync(destination).size;
      if (actualSize !== entry.size) {
        throw new SessionImportError('invalid_format', `附件大小不匹配: ${entry.id}`);
      }
      return {
        id: entry.id, turnId: entry.turnId, name: entry.name, mime: entry.mime,
        size: actualSize, mtime: entry.mtime ?? 0, localPath: destination,
        createdAt: entry.createdAt,
      };
    });
  }

  private restoreArtifacts(
    extracted: ReturnType<typeof extractSessionArchive>,
    files: SessionImportFileCommit,
    sessionId: string,
    warnings: ImportWarningWire[],
  ): ArtifactRestoreRow[] {
    if (!extracted.has('artifacts/index.json')) return [];
    if (!this.ports.artifactsEnabled) {
      warnings.push({
        code: 'unsupported_feature',
        feature: 'artifacts',
        message: 'V1 未启用产物(Artifact)功能,已跳过备份中的产物数据。',
      });
      return [];
    }

    const index = extracted.readJson<ArtifactMeta[]>('artifacts/index.json') ?? [];
    assertArray(index, 'artifacts/index.json');
    return index.map((entry) => {
      assertPortableImportId(entry.id, 'Artifact id');
      if (entry.turnId !== null) assertPortableImportId(entry.turnId, 'Artifact turnId');
      const fileKey = `artifacts/${entry.id}${artifactExt(entry.type)}`;
      const source = extracted.filePath(fileKey);
      if (entry.contentLocation === 'file' && source) {
        const ext = path.extname(fileKey) || '.bin';
        const destination = files.copyToSession(source, 'artifacts', `${entry.id}${ext}`);
        return {
          id: entry.id, sessionId, turnId: entry.turnId, type: entry.type,
          title: entry.title, contentLocation: 'file', content: null,
          contentPath: destination, createdAt: entry.createdAt,
          appliedAt: entry.appliedAt ?? null, rejectedAt: entry.rejectedAt ?? null,
        };
      }
      const content = source ? fs.readFileSync(source, 'utf8') : null;
      return {
        id: entry.id, sessionId, turnId: entry.turnId, type: entry.type,
        title: entry.title, contentLocation: 'inline', content, contentPath: null,
        createdAt: entry.createdAt, appliedAt: entry.appliedAt ?? null,
        rejectedAt: entry.rejectedAt ?? null,
      };
    });
  }

  private buildPayload(
    extracted: ReturnType<typeof extractSessionArchive>,
    session: SessionExport,
    files: {
      audio: AudioRestoreRow[];
      attachments: AttachmentRestoreRow[];
      artifacts: ArtifactRestoreRow[];
    },
  ): SessionRestorePayload {
    const turns = readArray<TurnRestoreRow>(extracted, 'turns.json');
    const messages = readArray<MessageRestoreRow>(extracted, 'messages.json');
    const branches = readArray<BranchExport>(extracted, 'branches.json');
    const agentTasks = readArray<SessionRestorePayload['agentTasks'][number]>(extracted, 'agent_tasks.json');
    const agentTaskMessages = readArray<SessionRestorePayload['agentTaskMessages'][number]>(extracted, 'agent_task_messages.json');
    const kbActivations = readArray<SessionRestorePayload['kbActivations'][number]>(extracted, 'kb_activations.json');
    const usageRecords = extracted.has('usage_records.json')
      ? readArray<SessionRestorePayload['usageRecords'][number]>(extracted, 'usage_records.json')
      : legacyMetricsToUsageRecords(
          extracted.has('llm_turn_metrics.json')
            ? readArray<LegacyLlmTurnMetrics>(extracted, 'llm_turn_metrics.json')
            : readArray<LegacyLlmTurnMetrics>(extracted, 'usage.json'),
          turns,
          session.id,
        );
    const memoryState = extracted.readJson<SessionRestorePayload['memoryState']>('memory_state.json');
    const notes = extracted.readJson<NotesExport>('notes.json');

    return {
      session: {
        id: session.id, title: session.title,
        workspaceRoot: session.workspaceRoot ?? null,
        createdAt: session.createdAt, updatedAt: session.updatedAt,
        lastActivityAt: session.lastActivityAt ?? session.updatedAt,
        archivedAt: session.archivedAt ?? null, pinned: session.pinned ?? false,
        pinnedAt: session.pinnedAt ?? null, groupLabel: session.groupLabel ?? null,
        parentSessionId: session.parentSessionId ?? null,
        executionProfile: session.executionProfile,
        narrativePolicy: session.narrativePolicy,
        activeBranchId: session.activeBranchId ?? null,
        preferredProviderConfigId: session.preferredProviderConfigId ?? null,
        preferredModelId: session.preferredModelId ?? null,
      },
      branches: branches.map((branch) => ({ ...branch, session_id: session.id })),
      turns,
      messages: messages.map((message: MessageRestoreRow & { blocks?: unknown }) => ({
        ...message,
        blocksJson: message.blocksJson ?? JSON.stringify(message.blocks ?? []),
      })),
      artifacts: files.artifacts,
      audio: files.audio,
      attachments: files.attachments,
      agentTasks,
      agentTaskMessages,
      memoryState,
      kbActivations,
      usageRecords,
      notes: notes ? {
        body: notes.body,
        tokensAtLastUpdate: notes.tokensAtLastUpdate ?? 0,
        updatedAt: notes.updatedAt,
      } : null,
    };
  }
}

interface LegacyLlmTurnMetrics {
  turn_id: string;
  llm_provider: string;
  model_id: string;
  input_tokens: number;
  output_tokens: number;
  cost_usd: number;
  duration_ms: number;
  created_at: number;
}

function legacyMetricsToUsageRecords(
  rows: readonly LegacyLlmTurnMetrics[],
  turns: readonly TurnRestoreRow[],
  sessionId: string,
): SessionRestorePayload['usageRecords'] {
  const turnIds = new Set(turns.map((turn) => turn.id));
  return rows.filter((row) => turnIds.has(row.turn_id)).map((row) => ({
    id: `legacy:${row.turn_id}`,
    session_id: sessionId,
    turn_id: row.turn_id,
    provider_id: `legacy-protocol:${row.llm_provider}`,
    model_id: row.model_id,
    capability: 'llm',
    status: 'completed',
    input_tokens: row.input_tokens,
    output_tokens: row.output_tokens,
    cache_read_input_tokens: null,
    cache_write_input_tokens: null,
    quantity: null,
    unit: null,
    cost_usd: row.cost_usd,
    duration_ms: row.duration_ms,
    error_code: null,
    created_at: row.created_at,
  }));
}

async function readBoundedSource(
  source: BackupArchiveSource,
  signal?: AbortSignal,
): Promise<Uint8Array> {
  if (signal?.aborted) throw new SessionImportError('import_cancelled', 'Session 导入已取消');
  if (source.declaredSize !== null && source.declaredSize > SESSION_IMPORT_LIMITS.maxArchiveBytes) {
    throw new SessionImportError('archive_too_large', 'ZIP 文件超过 V1 导入大小限制', 413);
  }

  if (source.declaredSize !== null) {
    const result = new Uint8Array(source.declaredSize);
    let offset = 0;
    for await (const chunk of source.chunks()) {
      if (signal?.aborted) throw new SessionImportError('import_cancelled', 'Session 导入已取消');
      if (offset + chunk.byteLength > result.byteLength) {
        throw new SessionImportError('invalid_format', '上传数据超过声明大小');
      }
      result.set(chunk, offset);
      offset += chunk.byteLength;
    }
    if (offset !== result.byteLength) {
      throw new SessionImportError('invalid_format', '上传数据长度与声明大小不一致');
    }
    return result;
  }

  const chunks: Uint8Array[] = [];
  let total = 0;
  for await (const chunk of source.chunks()) {
    if (signal?.aborted) throw new SessionImportError('import_cancelled', 'Session 导入已取消');
    total += chunk.byteLength;
    if (total > SESSION_IMPORT_LIMITS.maxArchiveBytes) {
      throw new SessionImportError('archive_too_large', 'ZIP 文件超过 V1 导入大小限制', 413);
    }
    chunks.push(chunk);
  }
  const result = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return result;
}

function readArray<T>(
  extracted: ReturnType<typeof extractSessionArchive>,
  name: string,
): T[] {
  const value = extracted.readJson<T[]>(name) ?? [];
  assertArray(value, name);
  return value;
}

function assertArray(value: unknown, entryName: string): asserts value is unknown[] {
  if (!Array.isArray(value)) {
    throw new SessionImportError('invalid_format', `${entryName} 必须是数组`);
  }
}

function requireArchiveFile(
  extracted: ReturnType<typeof extractSessionArchive>,
  name: string,
): string {
  const filePath = extracted.filePath(name);
  if (!filePath) throw new SessionImportError('invalid_format', `备份缺少 ${name}`);
  return filePath;
}

function safeImportedFileName(value: unknown): string {
  if (typeof value !== 'string' || value.length === 0) {
    throw new SessionImportError('invalid_format', '附件名称无效');
  }
  return value.replace(/[/\\?%*:|"<>]/g, '_').slice(0, 80);
}

function mimeToExt(mime: string): string {
  if (mime.includes('mp3') || mime.includes('mpeg')) return '.mp3';
  if (mime.includes('ogg')) return '.ogg';
  if (mime.includes('wav')) return '.wav';
  if (mime.includes('flac')) return '.flac';
  return '.mp3';
}

function artifactExt(type: string): string {
  const extensions: Record<string, string> = {
    code: '.txt', markdown: '.md', diff: '.diff', image: '.bin',
    json: '.json', html: '.html', svg: '.svg',
  };
  return extensions[type] ?? '.txt';
}
