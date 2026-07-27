import { Hono } from 'hono';
import { z }    from 'zod';
import fs   from 'node:fs';
import path from 'node:path';
import {
  SessionExportError,
  SessionImportError,
  type BackupArchiveSource,
  type SessionExportResult,
} from '@ema-agent/backup';
import type {
  SessionDashboardWire,
  AudioEntryWire,
  SessionNoteWire,
  SessionNoteEntryWire,
} from '@ema-agent/session';
import { asSessionId } from '@ema-agent/ids';
import {
  loadRegistry, addDir, removeDir, setActive,
  dataDbPathFor,
} from '../storage-locations/index.js';
import type { AppBindings } from '../wiring/index.js';

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

export function storageStatsRoute(bindings: AppBindings): Hono {
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
    const stats      = bindings.storageStats.getStats();
    const activeDir  = bindings.activeDataDir;
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
    const activeDir = bindings.activeDataDir;
    if (path.resolve(targetPath) === path.resolve(activeDir))
      return c.json({ error: 'same_path', message: '目标路径与当前路径相同' }, 400);

    try {
      fs.mkdirSync(targetPath, { recursive: true });
      await bindings.dataDb.sqlite.backup(path.join(targetPath, 'data.db'));
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

    const stats     = bindings.sessionStats.getStats(sessionId);
    const audioRows = bindings.sessionStats.listAudioEntries(sessionId);
    const noteRow   = bindings.sessionNotes.findBySession(asSessionId(sessionId));

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
    const noteRow   = bindings.sessionNotes.findBySession(asSessionId(sessionId));
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

  app.post('/sessions/:id/export', (c) => {
    let result: SessionExportResult | null;
    try {
      result = bindings.sessionBackup.exportSession({
        sessionId: c.req.param('id'),
      });
    } catch (error) {
      if (error instanceof SessionExportError) {
        return c.json({ error: error.code, message: error.message }, error.status);
      }
      throw error;
    }
    if (!result) return c.json({ error: 'session_not_found' }, 404);

    // Uint8Array 的底层可能是 SharedArrayBufferLike，复制为标准 ArrayBuffer
    // 以满足 Web Response 在 Node/Tauri 两端一致的 BodyInit 契约。
    return new Response(new Uint8Array(result.bytes).buffer, {
      status: 200,
      headers: {
        'Content-Type': result.mimeType,
        'Content-Disposition': `attachment; filename*=UTF-8''${encodeURIComponent(result.filename)}`,
        'Content-Length': String(result.bytes.byteLength),
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

        const result = await bindings.sessionBackup.importSession({
          source: backupSourceFromFile(file),
          format: 'auto',
          signal: c.req.raw.signal,
        });
        const restored = bindings.session.getSession(asSessionId(result.sessionId));
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
