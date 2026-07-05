import { Hono } from 'hono';
import { z }    from 'zod';
import fs   from 'node:fs';
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
import type {
  TurnRestoreRow, MessageRestoreRow, ArtifactRestoreRow,
  AudioRestoreRow, AttachmentRestoreRow, SessionRestorePayload,
} from '@ema-agent/storage';
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
      branchCount:          stats.branchCount,
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

  app.post('/sessions/:id/export', async (c) => {
    const sessionId = c.req.param('id');

    const session = bindings.session.getSession(asSessionId(sessionId));
    if (!session) return c.json({ error: 'session_not_found' }, 404);

    // All DB reads via repo — no direct db access in the route
    const turns          = bindings.session.listTurns(asSessionId(sessionId), 10_000);
    const messages       = bindings.session.listMessages(asSessionId(sessionId), { limit: 10_000 });
    const artifacts      = bindings.artifactStore.listForExport(asSessionId(sessionId));
    const attachments    = bindings.attachmentStore.listBySession(sessionId);
    const audioRows      = bindings.sessionStats.listAudioEntries(sessionId);
    const noteRow        = bindings.sessionNotes.findBySession(asSessionId(sessionId));
    const branchRows     = bindings.sessionStats.listBranches(sessionId);
    const agentTasks     = bindings.sessionStats.listAgentTasks(sessionId);
    const agentTaskMsgs  = bindings.sessionStats.listAgentTaskMessages(sessionId);
    const memState       = bindings.sessionStats.getMemoryState(sessionId);
    const kbActivations  = bindings.sessionStats.listKbActivations(sessionId);
    const turnUsage      = bindings.sessionStats.listTurnUsage(sessionId);

    // Route is responsible only for fs reads + zip assembly
    const files: Record<string, Uint8Array> = {};

    files['manifest.json'] = strToU8(JSON.stringify({
      version: '1', exportedAt: Date.now(), sessionId, generator: 'ema-agent-v1',
    }, null, 2));

    files['session.json']  = strToU8(JSON.stringify(session,  null, 2));
    files['turns.json']    = strToU8(JSON.stringify(turns,    null, 2));
    files['messages.json'] = strToU8(JSON.stringify(messages, null, 2));
    files['branches.json'] = strToU8(JSON.stringify(branchRows, null, 2));
    files['agent_tasks.json']         = strToU8(JSON.stringify(agentTasks,    null, 2));
    files['agent_task_messages.json'] = strToU8(JSON.stringify(agentTaskMsgs, null, 2));
    if (memState)              files['memory_state.json']   = strToU8(JSON.stringify(memState,      null, 2));
    if (kbActivations.length)  files['kb_activations.json'] = strToU8(JSON.stringify(kbActivations, null, 2));
    if (turnUsage.length)      files['usage.json']           = strToU8(JSON.stringify(turnUsage,     null, 2));

    const artifactIndex = artifacts.map((a) => ({
      id: a.id, type: a.type, title: a.title, contentLocation: a.contentLocation,
      createdAt: a.createdAt,
      appliedAt:  (a as { appliedAt?:  number }).appliedAt  ?? null,
      rejectedAt: (a as { rejectedAt?: number }).rejectedAt ?? null,
    }));
    files['artifacts/index.json'] = strToU8(JSON.stringify(artifactIndex, null, 2));
    for (const art of artifacts) {
      if (art.contentLocation === 'inline' && art.content) {
        files[`artifacts/${art.id}${artifactExt(art.type)}`] = strToU8(art.content);
      } else if (art.contentLocation === 'file') {
        const fp = (art as { contentPath?: string }).contentPath;
        if (fp && fs.existsSync(fp))
          files[`artifacts/${art.id}${path.extname(fp) || '.bin'}`] = new Uint8Array(fs.readFileSync(fp).buffer);
      }
    }

    const audioIndex = audioRows.map((r) => ({
      turnId: r.turn_id, mimeType: r.mime_type, byteSize: r.byte_size,
      durationMs: r.duration_ms, segmentCount: r.segment_count, createdAt: r.created_at,
    }));
    files['audio/index.json'] = strToU8(JSON.stringify(audioIndex, null, 2));
    for (const r of audioRows) {
      if (r.storage_path && fs.existsSync(r.storage_path)) {
        const ext = path.extname(r.storage_path) || mimeToExt(r.mime_type);
        files[`audio/${r.turn_id}${ext}`] = new Uint8Array(fs.readFileSync(r.storage_path).buffer);
      }
    }

    const attachIndex = attachments.map((a) => ({
      id: a.id, name: a.name, mime: a.mime, size: a.size,
      turnId: a.turnId, mtime: a.mtime, createdAt: a.createdAt,
    }));
    files['attachments/index.json'] = strToU8(JSON.stringify(attachIndex, null, 2));
    for (const att of attachments) {
      if (att.localPath && fs.existsSync(att.localPath)) {
        const safeName = att.name.replace(/[/\\?%*:|"<>]/g, '_').slice(0, 80);
        files[`attachments/${att.id}_${safeName}`] = new Uint8Array(fs.readFileSync(att.localPath).buffer);
      }
    }

    if (noteRow) {
      files['notes.json'] = strToU8(JSON.stringify({
        sessionId, body: noteRow.body,
        tokensAtLastUpdate: noteRow.tokens_at_last_update, updatedAt: noteRow.updated_at,
      }, null, 2));
    }

    const zipData   = zipSync(files, { level: 6 });
    const safeTitle = (session.title || 'session').replace(/[^\w一-龥 -]/g, '').trim().slice(0, 30) || 'session';
    const filename  = `ema-${safeTitle}-${sessionId.slice(-6)}.zip`;

    return new Response(zipData, {
      status: 200,
      headers: {
        'Content-Type':        'application/zip',
        'Content-Disposition': `attachment; filename*=UTF-8''${encodeURIComponent(filename)}`,
        'Content-Length':      String(zipData.byteLength),
      },
    });
  });

  // ── POST /import ───────────────────────────────────────────────────────────
  // Route is responsible for: unzip, file writes to disk, building the typed
  // payload. All DB inserts delegated to bindings.sessionStats.restoreRows().

  app.post('/sessions/import', async (c) => {
    const body = await c.req.parseBody();
    const file = body['file'];
    if (!(file instanceof File))
      return c.json({ error: 'missing_file', message: '请上传 ZIP 文件（field: file）' }, 400);

    const uint8 = new Uint8Array(await file.arrayBuffer());
    let unzipped: Record<string, Uint8Array>;
    try { unzipped = unzipSync(uint8); }
    catch { return c.json({ error: 'invalid_zip', message: '无法解压 ZIP 文件' }, 400); }

    const manifestRaw = unzipped['manifest.json'];
    if (!manifestRaw) return c.json({ error: 'invalid_format', message: '缺少 manifest.json' }, 400);
    interface Manifest { version: string; }
    const manifest = JSON.parse(strFromU8(manifestRaw)) as Manifest;
    if (manifest.version !== '1')
      return c.json({ error: 'unsupported_version', message: `不支持版本 ${manifest.version}` }, 400);

    const sessionRaw = unzipped['session.json'];
    if (!sessionRaw) return c.json({ error: 'invalid_format', message: '缺少 session.json' }, 400);

    interface SessionExport {
      id: string; title: string; characterCardId: string; workspaceRoot: string | null;
      createdAt: number; updatedAt: number; lastActivityAt: number;
      archivedAt: number | null; pinned: boolean; pinnedAt: number | null;
      groupLabel: string | null; parentSessionId: string | null;
      lastMode: string | null; activeBranchId: string | null;
    }
    const sd = JSON.parse(strFromU8(sessionRaw)) as SessionExport;

    if (bindings.session.sessionExists(asSessionId(sd.id)))
      return c.json({ error: 'conflict', message: `会话 ${sd.id} 已存在，请先删除后再导入` }, 409);

    // ── File writes (route responsibility) ───────────────────────────────────

    const audioRestoreRows: AudioRestoreRow[] = [];
    if (unzipped['audio/index.json']) {
      interface AudioMeta { turnId: string; mimeType: string; byteSize: number; durationMs: number | null; segmentCount: number; createdAt: number; }
      const audioIndex = JSON.parse(strFromU8(unzipped['audio/index.json'])) as AudioMeta[];
      const audioDir   = path.join(bindings.activeDataDir, 'audio', 'merged');
      fs.mkdirSync(audioDir, { recursive: true });
      for (const entry of audioIndex) {
        const ext      = mimeToExt(entry.mimeType);
        const fileKey  = `audio/${entry.turnId}${ext}`;
        if (!unzipped[fileKey]) continue;
        const destPath = path.join(audioDir, `${entry.turnId}${ext}`);
        fs.writeFileSync(destPath, unzipped[fileKey]);
        audioRestoreRows.push({ turnId: entry.turnId, sessionId: sd.id, storagePath: destPath, mimeType: entry.mimeType, byteSize: entry.byteSize, durationMs: entry.durationMs, segmentCount: entry.segmentCount, createdAt: entry.createdAt });
      }
    }

    const attachRestoreRows: AttachmentRestoreRow[] = [];
    if (unzipped['attachments/index.json']) {
      interface AttMeta { id: string; name: string; mime: string; size: number; turnId: string; mtime: number; createdAt: number; }
      const attIndex = JSON.parse(strFromU8(unzipped['attachments/index.json'])) as AttMeta[];
      const attDir   = path.join(bindings.activeDataDir, 'attachments');
      fs.mkdirSync(attDir, { recursive: true });
      for (const att of attIndex) {
        const safeName = att.name.replace(/[/\\?%*:|"<>]/g, '_').slice(0, 80);
        const fileKey  = `attachments/${att.id}_${safeName}`;
        if (!unzipped[fileKey]) continue;
        const destPath = path.join(attDir, `${att.id}_${safeName}`);
        fs.writeFileSync(destPath, unzipped[fileKey]);
        attachRestoreRows.push({ id: att.id, turnId: att.turnId, name: att.name, mime: att.mime, size: att.size, mtime: att.mtime ?? 0, localPath: destPath, createdAt: att.createdAt });
      }
    }

    const artifactRestoreRows: ArtifactRestoreRow[] = [];
    if (unzipped['artifacts/index.json']) {
      interface ArtMeta { id: string; type: string; title: string; contentLocation: string; createdAt: number; appliedAt: number | null; rejectedAt: number | null; }
      const artIndex = JSON.parse(strFromU8(unzipped['artifacts/index.json'])) as ArtMeta[];
      for (const art of artIndex) {
        const fileKey = `artifacts/${art.id}${artifactExt(art.type)}`;
        const content = unzipped[fileKey] ? strFromU8(unzipped[fileKey]) : null;
        artifactRestoreRows.push({ id: art.id, type: art.type, title: art.title, contentLocation: art.contentLocation, content, contentPath: null, createdAt: art.createdAt, appliedAt: art.appliedAt ?? null, rejectedAt: art.rejectedAt ?? null });
      }
    }

    // ── Build typed payload and delegate all DB writes to the repo ────────────

    const turns:    TurnRestoreRow[]    = unzipped['turns.json']    ? JSON.parse(strFromU8(unzipped['turns.json']))    as TurnRestoreRow[]    : [];
    const messages: MessageRestoreRow[] = unzipped['messages.json'] ? JSON.parse(strFromU8(unzipped['messages.json'])) as MessageRestoreRow[] : [];

    interface BranchExport { id: string; parent_branch_id: string | null; fork_from_turn_id: string | null; created_at: number; }
    const branches = unzipped['branches.json'] ? JSON.parse(strFromU8(unzipped['branches.json'])) as BranchExport[] : [];

    const agentTasks    = unzipped['agent_tasks.json']         ? JSON.parse(strFromU8(unzipped['agent_tasks.json']))         : [];
    const agentTaskMsgs = unzipped['agent_task_messages.json'] ? JSON.parse(strFromU8(unzipped['agent_task_messages.json'])) : [];
    const memoryState   = unzipped['memory_state.json']        ? JSON.parse(strFromU8(unzipped['memory_state.json']))        : null;
    const kbActivations = unzipped['kb_activations.json']      ? JSON.parse(strFromU8(unzipped['kb_activations.json']))      : [];
    const turnUsage     = unzipped['usage.json']               ? JSON.parse(strFromU8(unzipped['usage.json']))               : [];

    interface NotesExport { body: string; tokensAtLastUpdate: number; updatedAt: number; }
    const notes: NotesExport | null = unzipped['notes.json'] ? JSON.parse(strFromU8(unzipped['notes.json'])) as NotesExport : null;

    const payload: SessionRestorePayload = {
      session: {
        id: sd.id, title: sd.title, characterCardId: sd.characterCardId ?? 'ema',
        workspaceRoot: sd.workspaceRoot ?? null,
        createdAt: sd.createdAt, updatedAt: sd.updatedAt,
        lastActivityAt: sd.lastActivityAt ?? sd.updatedAt,
        archivedAt: sd.archivedAt ?? null, pinned: sd.pinned ?? false,
        pinnedAt: sd.pinnedAt ?? null, groupLabel: sd.groupLabel ?? null,
        parentSessionId: sd.parentSessionId ?? null, lastMode: sd.lastMode ?? null,
        activeBranchId: sd.activeBranchId ?? null,
      },
      branches: branches.map((b: BranchExport) => ({ ...b, session_id: sd.id })),
      turns,
      messages: messages.map((m: MessageRestoreRow & { blocks?: unknown }) => ({
        ...m,
        blocksJson: m.blocksJson ?? JSON.stringify((m as { blocks?: unknown }).blocks ?? []),
      })),
      artifacts:         artifactRestoreRows,
      audio:             audioRestoreRows,
      attachments:       attachRestoreRows,
      agentTasks,
      agentTaskMessages: agentTaskMsgs,
      memoryState,
      kbActivations,
      turnUsage,
      notes: notes ? { body: notes.body, tokensAtLastUpdate: notes.tokensAtLastUpdate ?? 0, updatedAt: notes.updatedAt } : null,
    };

    bindings.sessionStats.restoreRows(payload);

    return c.json(bindings.session.getSession(asSessionId(sd.id)), 201);
  });

  return app;
}
