import { Hono } from 'hono';
import fs from 'node:fs';
import path from 'node:path';
import { zipSync, unzipSync, strToU8, strFromU8 } from 'fflate';
import type {
  SessionDashboardWire,
  ArtifactSummaryWire,
  AudioEntryWire,
  SessionNoteWire,
  SessionNoteEntryWire,
} from '@ema-agent/contracts';
import { asSessionId } from '@ema-agent/contracts';
import type { AppBindings } from '../wiring.js';

// ── Helpers ───────────────────────────────────────────────────────────────────

function parseNoteBody(body: string): SessionNoteEntryWire[] {
  try { return JSON.parse(body) as SessionNoteEntryWire[]; }
  catch { return []; }
}

function artifactExt(type: string): string {
  const map: Record<string, string> = {
    code: '.txt', markdown: '.md', diff: '.diff',
    image: '.bin', json: '.json', html: '.html', svg: '.svg',
  };
  return map[type] ?? '.txt';
}

function mimeToExt(mime: string): string {
  if (mime.includes('mp3') || mime.includes('mpeg')) return '.mp3';
  if (mime.includes('ogg'))  return '.ogg';
  if (mime.includes('wav'))  return '.wav';
  if (mime.includes('flac')) return '.flac';
  return '.mp3';
}

// ── Route factory ─────────────────────────────────────────────────────────────

export function sessionDetailRoute(bindings: AppBindings): Hono {
  const app = new Hono();

  // ── GET /:id/dashboard ────────────────────────────────────────────────────

  app.get('/:id/dashboard', (c) => {
    const sessionId = c.req.param('id');

    const stats     = bindings.sessionStats.getStats(sessionId);
    const audioRows = bindings.sessionStats.listAudioEntries(sessionId);
    const artRows   = bindings.sessionStats.listArtifactSummaries(sessionId);
    const noteRow   = bindings.sessionNotes.findBySession(asSessionId(sessionId));

    const audioEntries: AudioEntryWire[] = audioRows.map((r) => ({
      turnId:       r.turn_id,
      mimeType:     r.mime_type,
      byteSize:     r.byte_size,
      durationMs:   r.duration_ms,
      segmentCount: r.segment_count,
      createdAt:    r.created_at,
    }));

    const artifacts: ArtifactSummaryWire[] = artRows.map((r) => ({
      id:              r.id,
      type:            r.type,
      title:           r.title,
      contentLocation: r.content_location as 'inline' | 'file',
      byteSize:        r.byte_size,
      createdAt:       r.created_at,
      appliedAt:       r.applied_at,
      rejectedAt:      r.rejected_at,
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
      modeCounts:           { chat: stats.chatTurns, narrative: stats.narrativeTurns, agent: stats.agentTurns },
      artifactCount:        stats.artifactCount,
      artifactTotalBytes:   stats.artifactInlineBytes,
      artifacts,
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

  app.get('/:id/notes', (c) => {
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

  app.post('/:id/export', async (c) => {
    const sessionId = c.req.param('id');

    const session = bindings.session.getSession(asSessionId(sessionId));
    if (!session) return c.json({ error: 'session_not_found' }, 404);

    const turns       = bindings.session.listTurns(asSessionId(sessionId), 10_000);
    const messages    = bindings.session.listMessages(asSessionId(sessionId), { limit: 10_000 });
    const artifacts   = bindings.artifactStore.listForExport(asSessionId(sessionId));
    const attachments = bindings.attachmentStore.listBySession(sessionId);
    const audioRows   = bindings.sessionStats.listAudioEntries(sessionId);
    const noteRow     = bindings.sessionNotes.findBySession(asSessionId(sessionId));

    const files: Record<string, Uint8Array> = {};

    files['manifest.json'] = strToU8(JSON.stringify({
      version:    '1',
      exportedAt: Date.now(),
      sessionId,
      generator:  'ema-agent-v1',
    }, null, 2));

    files['session.json']  = strToU8(JSON.stringify(session,  null, 2));
    files['turns.json']    = strToU8(JSON.stringify(turns,    null, 2));
    files['messages.json'] = strToU8(JSON.stringify(messages, null, 2));

    const artifactIndex = artifacts.map((a) => ({
      id:              a.id,
      type:            a.type,
      title:           a.title,
      contentLocation: a.contentLocation,
      createdAt:       a.createdAt,
      appliedAt:       (a as { appliedAt?: number }).appliedAt   ?? null,
      rejectedAt:      (a as { rejectedAt?: number }).rejectedAt ?? null,
    }));
    files['artifacts/index.json'] = strToU8(JSON.stringify(artifactIndex, null, 2));

    for (const art of artifacts) {
      if (art.contentLocation === 'inline' && art.content) {
        files[`artifacts/${art.id}${artifactExt(art.type)}`] = strToU8(art.content);
      } else if (art.contentLocation === 'file') {
        const fp = (art as { contentPath?: string }).contentPath;
        if (fp && fs.existsSync(fp)) {
          files[`artifacts/${art.id}${path.extname(fp) || '.bin'}`] =
            new Uint8Array(fs.readFileSync(fp).buffer);
        }
      }
    }

    const audioIndex = audioRows.map((r) => ({
      turnId:       r.turn_id,
      mimeType:     r.mime_type,
      byteSize:     r.byte_size,
      durationMs:   r.duration_ms,
      segmentCount: r.segment_count,
      createdAt:    r.created_at,
    }));
    files['audio/index.json'] = strToU8(JSON.stringify(audioIndex, null, 2));

    for (const r of audioRows) {
      if (r.storage_path && fs.existsSync(r.storage_path)) {
        const ext = path.extname(r.storage_path) || mimeToExt(r.mime_type);
        files[`audio/${r.turn_id}${ext}`] = new Uint8Array(fs.readFileSync(r.storage_path).buffer);
      }
    }

    const attachIndex = attachments.map((a) => ({
      id:        a.id,
      name:      a.name,
      mime:      a.mime,
      size:      a.size,
      turnId:    a.turnId,
      mtime:     a.mtime,
      createdAt: a.createdAt,
    }));
    files['attachments/index.json'] = strToU8(JSON.stringify(attachIndex, null, 2));

    for (const att of attachments) {
      if (att.localPath && fs.existsSync(att.localPath)) {
        const safeName = att.name.replace(/[/\\?%*:|"<>]/g, '_').slice(0, 80);
        files[`attachments/${att.id}_${safeName}`] =
          new Uint8Array(fs.readFileSync(att.localPath).buffer);
      }
    }

    if (noteRow) {
      files['notes.json'] = strToU8(JSON.stringify({
        sessionId,
        body:               noteRow.body,
        tokensAtLastUpdate: noteRow.tokens_at_last_update,
        updatedAt:          noteRow.updated_at,
      }, null, 2));
    }

    const zipData   = zipSync(files, { level: 6 });
    const safeTitle = (session.title || 'session').replace(/[^\w一-龥 -]/g, '').trim().slice(0, 30) || 'session';
    const filename  = `ema-${safeTitle}-${sessionId.slice(-6)}.zip`;

    return new Response(zipData, {
      status:  200,
      headers: {
        'Content-Type':        'application/zip',
        'Content-Disposition': `attachment; filename*=UTF-8''${encodeURIComponent(filename)}`,
        'Content-Length':      String(zipData.byteLength),
      },
    });
  });

  // ── POST /import ───────────────────────────────────────────────────────────
  //
  // Import is a restore operation: inserts rows with original IDs and uses
  // INSERT OR IGNORE for idempotency. The normal store facades don't have
  // "insert with caller-supplied ID" semantics, so we write directly to
  // bindings.dataDb.sqlite — which is a first-class binding, not a new instance.

  app.post('/import', async (c) => {
    const body = await c.req.parseBody();
    const file = body['file'];
    if (!(file instanceof File)) {
      return c.json({ error: 'missing_file', message: '请上传 ZIP 文件（field: file）' }, 400);
    }

    const uint8 = new Uint8Array(await file.arrayBuffer());
    let unzipped: Record<string, Uint8Array>;
    try {
      unzipped = unzipSync(uint8);
    } catch {
      return c.json({ error: 'invalid_zip', message: '无法解压 ZIP 文件' }, 400);
    }

    const manifestRaw = unzipped['manifest.json'];
    if (!manifestRaw) return c.json({ error: 'invalid_format', message: '缺少 manifest.json' }, 400);

    interface Manifest { version: string; sessionId: string; }
    const manifest = JSON.parse(strFromU8(manifestRaw)) as Manifest;
    if (manifest.version !== '1') {
      return c.json({ error: 'unsupported_version', message: `不支持版本 ${manifest.version}` }, 400);
    }

    const sessionRaw = unzipped['session.json'];
    if (!sessionRaw) return c.json({ error: 'invalid_format', message: '缺少 session.json' }, 400);

    // Session domain object shape (camelCase, matches Session from @ema-agent/session)
    interface SessionExport {
      id: string; title: string; characterCardId: string; workspaceRoots: string[];
      createdAt: number; updatedAt: number; lastActivityAt: number;
      archivedAt: number | null; pinned: boolean; pinnedAt: number | null;
      groupLabel: string | null; parentSessionId: string | null; lastMode: string | null;
    }
    const sd = JSON.parse(strFromU8(sessionRaw)) as SessionExport;

    if (bindings.session.sessionExists(asSessionId(sd.id))) {
      return c.json({ error: 'conflict', message: `会话 ${sd.id} 已存在，请先删除后再导入` }, 409);
    }

    // Use bindings.dataDb.sqlite for batch insert-with-original-ID operations.
    const db = bindings.dataDb.sqlite;

    db.prepare(`
      INSERT INTO sessions
        (id, title, character_card_id, workspace_roots_json, created_at, updated_at,
         last_activity_at, archived_at, pinned, pinned_at, group_label,
         parent_session_id, last_mode, last_sub_mode, meta_json)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, '{}')
    `).run(
      sd.id, sd.title, sd.characterCardId ?? 'ema',
      JSON.stringify(sd.workspaceRoots ?? []),
      sd.createdAt, sd.updatedAt, sd.lastActivityAt ?? sd.updatedAt,
      sd.archivedAt ?? null, sd.pinned ? 1 : 0, sd.pinnedAt ?? null,
      sd.groupLabel ?? null, sd.parentSessionId ?? null, sd.lastMode ?? null,
    );

    // Turns — camelCase Turn domain objects
    if (unzipped['turns.json']) {
      interface TurnExport {
        id: string; sessionId: string; branchId: string | null; mode: string;
        status: string; userInput: string; startedAt: number;
        completedAt: number | null; errorCode: string | null; errorMessage: string | null;
        iterations: number; usageInputTokens: number; usageOutputTokens: number;
      }
      const turns = JSON.parse(strFromU8(unzipped['turns.json'])) as TurnExport[];
      const stmtTurn = db.prepare(`
        INSERT OR IGNORE INTO turns
          (id, session_id, mode, agent_sub_mode, branch_id, status, user_input,
           started_at, completed_at, error_code, error_message,
           iterations, usage_input_tokens, usage_output_tokens)
        VALUES (?, ?, ?, NULL, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `);
      db.transaction((rows: TurnExport[]) => {
        for (const t of rows) {
          stmtTurn.run(
            t.id, t.sessionId, t.mode, t.branchId ?? null,
            t.status, t.userInput, t.startedAt, t.completedAt ?? null,
            t.errorCode ?? null, t.errorMessage ?? null,
            t.iterations ?? 0, t.usageInputTokens ?? 0, t.usageOutputTokens ?? 0,
          );
        }
      })(turns);
    }

    // Messages — camelCase Message domain objects
    if (unzipped['messages.json']) {
      interface MsgExport {
        id: string; sessionId: string; turnId: string | null; role: string; kind: string;
        blocks: unknown; interrupted: boolean; createdAt: number;
      }
      const msgs = JSON.parse(strFromU8(unzipped['messages.json'])) as MsgExport[];
      const stmtMsg = db.prepare(`
        INSERT OR IGNORE INTO messages
          (id, session_id, turn_id, role, kind, blocks_json, interrupted, created_at, meta_json)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, '{}')
      `);
      db.transaction((rows: MsgExport[]) => {
        for (const m of rows) {
          stmtMsg.run(
            m.id, m.sessionId, m.turnId ?? null, m.role, m.kind ?? 'normal',
            JSON.stringify(m.blocks), m.interrupted ? 1 : 0, m.createdAt,
          );
        }
      })(msgs);
    }

    // Artifacts — camelCase ArtifactSummary index
    if (unzipped['artifacts/index.json']) {
      interface ArtMeta {
        id: string; type: string; title: string; contentLocation: string;
        createdAt: number; appliedAt: number | null; rejectedAt: number | null;
      }
      const artIndex = JSON.parse(strFromU8(unzipped['artifacts/index.json'])) as ArtMeta[];
      const stmtArt  = db.prepare(`
        INSERT OR IGNORE INTO artifacts
          (id, session_id, turn_id, type, title, content, content_location,
           content_path, meta_json, created_at, updated_at, applied_at, rejected_at)
        VALUES (?, ?, NULL, ?, ?, ?, ?, NULL, '{}', ?, ?, ?, ?)
      `);
      db.transaction((rows: ArtMeta[]) => {
        for (const art of rows) {
          const fileKey = `artifacts/${art.id}${artifactExt(art.type)}`;
          const content = unzipped[fileKey] ? strFromU8(unzipped[fileKey]) : null;
          stmtArt.run(
            art.id, sd.id, art.type, art.title, content, art.contentLocation,
            art.createdAt, art.createdAt, art.appliedAt ?? null, art.rejectedAt ?? null,
          );
        }
      })(artIndex);
    }

    // Audio — write files and register via bindings.sessionStats
    if (unzipped['audio/index.json']) {
      interface AudioMeta {
        turnId: string; mimeType: string; byteSize: number;
        durationMs: number | null; segmentCount: number; createdAt: number;
      }
      const audioIndex = JSON.parse(strFromU8(unzipped['audio/index.json'])) as AudioMeta[];
      const audioDir   = path.join(bindings.activeDataDir, 'audio', 'merged');
      fs.mkdirSync(audioDir, { recursive: true });

      for (const entry of audioIndex) {
        const ext     = mimeToExt(entry.mimeType);
        const fileKey = `audio/${entry.turnId}${ext}`;
        if (!unzipped[fileKey]) continue;
        const destPath = path.join(audioDir, `${entry.turnId}${ext}`);
        fs.writeFileSync(destPath, unzipped[fileKey]);
        bindings.sessionStats.insertAudio({
          turnId:       entry.turnId,
          sessionId:    sd.id,
          storagePath:  destPath,
          mimeType:     entry.mimeType,
          byteSize:     entry.byteSize,
          durationMs:   entry.durationMs,
          segmentCount: entry.segmentCount,
          createdAt:    entry.createdAt,
        });
      }
    }

    // Attachments — write files, insert rows via bindings.dataDb.sqlite
    if (unzipped['attachments/index.json']) {
      interface AttMeta {
        id: string; name: string; mime: string; size: number;
        turnId: string; mtime: number; createdAt: number;
      }
      const attIndex = JSON.parse(strFromU8(unzipped['attachments/index.json'])) as AttMeta[];
      const attDir   = path.join(bindings.activeDataDir, 'attachments');
      fs.mkdirSync(attDir, { recursive: true });
      const stmtAtt  = db.prepare(`
        INSERT OR IGNORE INTO turn_attachments
          (id, turn_id, session_id, name, mime, size, mtime, local_path, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `);
      db.transaction((rows: AttMeta[]) => {
        for (const att of rows) {
          const safeName = att.name.replace(/[/\\?%*:|"<>]/g, '_').slice(0, 80);
          const fileKey  = `attachments/${att.id}_${safeName}`;
          if (!unzipped[fileKey]) continue;
          const destPath = path.join(attDir, `${att.id}_${safeName}`);
          fs.writeFileSync(destPath, unzipped[fileKey]);
          stmtAtt.run(
            att.id, att.turnId, sd.id,
            att.name, att.mime, att.size, att.mtime ?? 0,
            destPath, att.createdAt,
          );
        }
      })(attIndex);
    }

    // Notes — via bindings.sessionNotes
    if (unzipped['notes.json']) {
      interface NotesExport {
        body: string; tokensAtLastUpdate: number; updatedAt: number;
      }
      const notesData = JSON.parse(strFromU8(unzipped['notes.json'])) as NotesExport;
      bindings.sessionNotes.upsert({
        sessionId:          asSessionId(sd.id),
        body:               notesData.body,
        tokensAtLastUpdate: notesData.tokensAtLastUpdate ?? 0,
        updatedAt:          notesData.updatedAt,
      });
    }

    return c.json(bindings.session.getSession(asSessionId(sd.id)), 201);
  });

  return app;
}
