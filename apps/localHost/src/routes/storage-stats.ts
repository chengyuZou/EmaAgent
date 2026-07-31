// 提供数据目录统计、迁移和 Session 备份的 LocalHost HTTP 适配。
import { Hono } from 'hono';
import { z }    from 'zod';
import fs   from 'node:fs';
import path from 'node:path';
import {
  SessionExportError,
  SessionImportError,
  type SessionBackupFacade,
  type BackupArchiveSource,
} from '@ema-agent/backup';
import type {
  SessionStore,
  SessionDashboardWire,
  AudioEntryWire,
  SessionNoteWire,
  SessionNoteEntryWire,
} from '@ema-agent/session';
import { asSessionId } from '@ema-agent/ids';
import type {
  Database,
  DataDirStatsRepo,
  SessionNotesRepo,
  SessionStatsRepo,
} from '@ema-agent/storage';
import {
  loadRegistry, addDir, removeDir, setActive,
  dataDbPathFor,
} from '../storage-locations/index.js';

export interface StorageStatsRouteDependencies {
  activeDataDir: string;
  dataDb: Pick<Database, 'sqlite'>;
  storageStats: Pick<DataDirStatsRepo, 'getStats'>;
  sessionStats: Pick<SessionStatsRepo, 'getStats' | 'listAudioEntries'>;
  sessionNotes: Pick<SessionNotesRepo, 'findBySession'>;
  sessionBackup: Pick<SessionBackupFacade, 'openSessionExport' | 'importSession'>;
  session: Pick<SessionStore, 'getSession'>;
}

// ── Shared fs helpers ─────────────────────────────────────────────────────────

function safeStatSize(filePath: string): number {
  try { return fs.statSync(filePath).size; } catch { return 0; }
}

function dirBytes(dirPath: string): number {
  try {
    let total = 0;
    for (const entry of fs.readdirSync(dirPath, { withFileTypes: true })) {
      const full = path.join(dirPath, entry.name);
      total += entry.isDirectory() ? dirBytes(full) : safeStatSize(full);
    }
    return total;
  } catch { return 0; }
}

// ── Session-detail helpers ────────────────────────────────────────────────────

function parseNoteBody(body: string): SessionNoteEntryWire[] {
  try { return JSON.parse(body) as SessionNoteEntryWire[]; }
  catch { return []; }
}

function backupSourceFromFile(file: File): BackupArchiveSource {
  return {
    declaredSize: file.size,
    async *chunks() {
      const reader = file.stream().getReader();
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) return;
          if (value.byteLength > 0) yield value;
        }
      } finally {
        reader.releaseLock();
      }
    },
  };
}

// ── Route factory ─────────────────────────────────────────────────────────────

export function storageStatsRoute(dependencies: StorageStatsRouteDependencies): Hono {
  const app = new Hono();

  // ── GET /api/storage — list all registered data dirs ─────────────────────
  app.get('/', (c) => {
    const reg = loadRegistry();
    const items = reg.dirs.map((d) => ({
      name:        d.name,
      path:        d.path,
      isActive:    d.name === reg.active,
      addedAt:     d.addedAt,
      dataDbBytes: safeStatSize(dataDbPathFor(d.path)),
    }));
    return c.json({ active: reg.active, dirs: items });
  });

  // ── POST /api/storage — register a new data dir ───────────────────────────
  app.post('/', async (c) => {
    const body = z.object({
      name: z.string().min(1),
      path: z.string().min(1),
    }).safeParse(await c.req.json().catch(() => null));
    if (!body.success)
      return c.json({ error: 'invalid_request', details: body.error.flatten() }, 400);
    try {
      const next  = addDir(loadRegistry(), { name: body.data.name, path: body.data.path });
      const added = next.dirs.find((d) => d.name === body.data.name)!;
      return c.json({ name: added.name, path: added.path, addedAt: added.addedAt }, 201);
    } catch (err) {
      return c.json({ error: 'add_failed', message: (err as Error).message }, 400);
    }
  });

  // ── DELETE /api/storage/:name — unregister (no disk deletion) ────────────
  app.delete('/:name', (c) => {
    const name = c.req.param('name');
    try {
      removeDir(loadRegistry(), name);
      return c.json({ ok: true });
    } catch (err) {
      return c.json({ error: 'remove_failed', message: (err as Error).message }, 400);
    }
  });

  // ── POST /api/storage/:name/activate — switch active dir (restart needed) ─
  app.post('/:name/activate', (c) => {
    const name = c.req.param('name');
    try {
      setActive(loadRegistry(), name);
      return c.json({ ok: true, restartRequired: true });
    } catch (err) {
      return c.json({ error: 'activate_failed', message: (err as Error).message }, 400);
    }
  });

  // ── GET /api/storage/stats — aggregate stats for the active data dir ──────
  app.get('/stats', (c) => {
    const stats      = dependencies.storageStats.getStats();
    const activeDir  = dependencies.activeDataDir;
    const dataDbBytes   = safeStatSize(dataDbPathFor(activeDir));
    const audioBytes    = dirBytes(path.join(activeDir, 'audio'));
    const sessionsBytes = dirBytes(path.join(activeDir, 'sessions'));
    return c.json({
      path: activeDir,
      ...stats,
      dataDbBytes,
      audioBytes,
      sessionsBytes,
      totalBytes: dataDbBytes + audioBytes + sessionsBytes,
    });
  });

  // ── POST /api/storage/migrate — hot-copy active dir to new path ───────────
  app.post('/migrate', async (c) => {
    const body = z.object({
      name:       z.string().min(1),
      targetPath: z.string().min(1),
    }).safeParse(await c.req.json().catch(() => null));
    if (!body.success)
      return c.json({ error: 'invalid_request', details: body.error.flatten() }, 400);

    const { name, targetPath } = body.data;
    const activeDir = dependencies.activeDataDir;
    if (path.resolve(targetPath) === path.resolve(activeDir))
      return c.json({ error: 'same_path', message: '目标路径与当前路径相同' }, 400);

    try {
      fs.mkdirSync(targetPath, { recursive: true });
      await dependencies.dataDb.sqlite.backup(path.join(targetPath, 'data.db'));
      const srcSessions = path.join(activeDir, 'sessions');
      if (fs.existsSync(srcSessions))
        fs.cpSync(srcSessions, path.join(targetPath, 'sessions'), { recursive: true });
      const srcAudio = path.join(activeDir, 'audio');
      if (fs.existsSync(srcAudio))
        fs.cpSync(srcAudio, path.join(targetPath, 'audio'), { recursive: true });
      const reg = addDir(loadRegistry(), { name, path: targetPath });
      setActive(reg, name);
      return c.json({ ok: true, restartRequired: true, targetPath });
    } catch (err) {
      return c.json({ error: 'migrate_failed', message: (err as Error).message }, 500);
    }
  });

  // ── GET /api/storage/sessions/:id/dashboard ───────────────────────────────

  app.get('/sessions/:id/dashboard', (c) => {
    const sessionId = c.req.param('id');

    const stats     = dependencies.sessionStats.getStats(sessionId);
    const audioRows = dependencies.sessionStats.listAudioEntries(sessionId);
    const noteRow   = dependencies.sessionNotes.findBySession(asSessionId(sessionId));

    const audioEntries: AudioEntryWire[] = audioRows.map((r) => ({
      turnId:       r.turn_id,
      mimeType:     r.mime_type,
      byteSize:     r.byte_size,
      durationMs:   r.duration_ms,
      segmentCount: r.segment_count,
      createdAt:    r.created_at,
    }));

    const notes: SessionNoteWire | null = noteRow
      ? {
          sessionId,
          entries:            parseNoteBody(noteRow.body),
          tokensAtLastUpdate: noteRow.tokens_at_last_update,
          updatedAt:          noteRow.updated_at,
        }
      : null;

    const dashboard: SessionDashboardWire = {
      sessionId,
      turnCount:            stats.turnCount,
      messageCount:         stats.messageCount,
      totalInputTokens:     stats.totalInputTokens,
      totalOutputTokens:    stats.totalOutputTokens,
      turnCounts: {
        chat: stats.chatTurns,
        work: stats.workTurns,
        narrativeAlways: stats.narrativeAlwaysTurns,
      },
      audioTurnCount:       stats.audioTurnCount,
      audioTotalBytes:      stats.audioTotalBytes,
      audioTotalDurationMs: stats.audioTotalDurationMs,
      audioEntries,
      attachmentCount:      stats.attachmentCount,
      attachmentTotalBytes: stats.attachmentTotalBytes,
      notes,
    };

    return c.json(dashboard satisfies SessionDashboardWire);
  });

  // ── GET /:id/notes ─────────────────────────────────────────────────────────

  app.get('/sessions/:id/notes', (c) => {
    const sessionId = c.req.param('id');
    const noteRow   = dependencies.sessionNotes.findBySession(asSessionId(sessionId));
    if (!noteRow) return c.json(null);
    const wire: SessionNoteWire = {
      sessionId,
      entries:            parseNoteBody(noteRow.body),
      tokensAtLastUpdate: noteRow.tokens_at_last_update,
      updatedAt:          noteRow.updated_at,
    };
    return c.json(wire satisfies SessionNoteWire);
  });

  // ── POST /:id/export ───────────────────────────────────────────────────────

  app.post('/sessions/:id/export', async (c) => {
    let opened;
    try {
      opened = dependencies.sessionBackup.openSessionExport({
        sessionId: c.req.param('id'),
        signal: c.req.raw.signal,
      });
    } catch (error) {
      if (error instanceof SessionExportError) {
        return c.json({ error: error.code, message: error.message }, error.status as 413);
      }
      throw error;
    }
    if (!opened) return c.json({ error: 'session_not_found' }, 404);

    // ZIP 经 Sink 流式写入 HTTP 响应,不整包驻留内存;客户端断开即中止写入。
    let cancelled = false;
    const stream = new ReadableStream<Uint8Array>({
      async start(controller) {
        try {
          await opened.writeTo({
            write: async (chunk) => {
              if (cancelled) throw new Error('export cancelled by client');
              controller.enqueue(chunk);
            },
            commit: async () => { controller.close(); },
            abort: async () => { if (!cancelled) controller.error(new Error('export aborted')); },
          });
        } catch (error) {
          if (!cancelled) controller.error(error);
        }
      },
      cancel() {
        cancelled = true;
      },
    });
    return new Response(stream, {
      status: 200,
      headers: {
        'Content-Type': opened.mimeType,
        'Content-Disposition': `attachment; filename*=UTF-8''${encodeURIComponent(opened.filename)}`,
      },
    });
  });

  // ── POST /import ───────────────────────────────────────────────────────────
  // Route 只适配 multipart 与 HTTP；解压、文件提交、Payload 构造和数据库恢复
  // 必须统一经过 SessionBackupFacade，禁止在 LocalHost 复制备份业务规则。

  app.post(
    '/sessions/import',
    async (c) => {
      try {
        const body = await c.req.parseBody();
        const file = body['file'];
        if (!(file instanceof File)) {
          return c.json({
            error: 'missing_file',
            message: '请上传 ZIP 文件（field: file）',
          }, 400);
        }

        const result = await dependencies.sessionBackup.importSession({
          source: backupSourceFromFile(file),
          format: 'auto',
          signal: c.req.raw.signal,
        });
        const restored = dependencies.session.getSession(asSessionId(result.sessionId));
        return c.json(restored, 201);
      } catch (error) {
        if (error instanceof SessionImportError) {
          return c.json({ error: error.code, message: error.message }, error.status);
        }
        throw error;
      }
    },
  );

  return app;
}
