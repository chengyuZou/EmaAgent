import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { once } from 'node:events';
import type { Server } from 'node:http';
import { serve } from '@hono/node-server';
import { Hono } from 'hono';
import { strFromU8, strToU8, unzipSync, zipSync } from 'fflate';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { WebSocket, WebSocketServer } from 'ws';
import { SessionBackup } from '@ema-agent/backup';
import { SessionRunningRegistry } from '@ema-agent/session';
import { FsAudioArchive, type SpeechGenerateEvent } from '@ema-agent/speech';
import { Database, SessionBackupReader, SessionBackupRestorer, SpeechOutputsRepo } from '@ema-agent/storage';
import { createPcmWavHeader } from '@ema-agent/tts';
import { TurnStore } from '@ema-agent/turn';
import type { SpeechComposition, SpeechSocketClient } from '../src/composition/speech.js';
import { emaAuth, localWebviewCors } from '../src/platform/auth.js';
import { removeTurnFiles, sweepOrphanTurnFiles } from '../src/platform/paths.js';
import { turnAudioRoute } from '../src/routes/turns/audio.js';
import { speechWebSocketRoute } from '../src/routes/ws/speech.js';

const SECRET = 's'.repeat(32);
const FORMAT = { sampleRate: 8000, channelCount: 1 };
const HEADER_BYTES = createPcmWavHeader(FORMAT, 0).byteLength;
const roots: string[] = [];
const databases: Database[] = [];
let server: Server | null = null;
let webSocketServer: WebSocketServer | null = null;

afterEach(async () => {
  for (const socket of webSocketServer?.clients ?? []) socket.terminate();
  webSocketServer?.close();
  webSocketServer = null;
  if (server) {
    const running = server;
    const closed = new Promise<void>(resolve => running.close(() => resolve()));
    running.closeAllConnections();
    await closed;
    server = null;
  }
  for (const db of databases.splice(0)) db.close();
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

function temporaryRoot(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ema-speech-server-'));
  roots.push(root);
  return root;
}

function database(): Database {
  const db = new Database({ memory: true, kind: 'data' });
  databases.push(db);
  db.migrate();
  return db;
}

function fixture() {
  const root = temporaryRoot();
  const db = database();
  db.sqlite.prepare('INSERT INTO sessions (id, title, cwd, last_activity_at, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)')
    .run('session', '音频测试', 'D:/work', 1, 1, 1);
  db.sqlite.prepare('INSERT INTO turns (id, session_id, status, created_at) VALUES (?, ?, ?, ?)')
    .run('turn', 'session', 'completed', 1);
  const turns = new TurnStore({ db, sessionRunning: new SessionRunningRegistry() });
  const archive = new FsAudioArchive(path.join(root, 'sessions'));
  return { root, db, turns, archive };
}

function application() {
  const app = new Hono();
  app.use('*', localWebviewCors());
  app.use('*', emaAuth(SECRET));
  return app;
}

async function listen(app: Hono, withWebSocket = false): Promise<string> {
  if (withWebSocket) webSocketServer = new WebSocketServer({ noServer: true });
  server = serve({
    fetch: app.fetch,
    hostname: '127.0.0.1',
    port: 0,
    ...(webSocketServer ? { websocket: { server: webSocketServer } } : {}),
  }) as Server;
  await once(server, 'listening');
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('test server did not bind a TCP port');
  return 'http://127.0.0.1:' + address.port;
}

describe('Speech WebSocket', () => {
  it('只传生成状态与显式取消指令, 事件带 Session 和 Turn 而不带 URL 或音频', async () => {
    const { turns } = fixture();
    let client!: SpeechSocketClient;
    const app = application();
    const attached = new Promise<void>(resolve => {
      const speech: Pick<SpeechComposition, 'attachSpeechSocket' | 'detachSpeechSocket' | 'cancelTurnSpeech'> = {
        async attachSpeechSocket(sessionId, turnId, socket) {
          client = socket;
          socket.sendControl({ type: 'speech_generate_started', sessionId, turnId });
          resolve();
        },
        detachSpeechSocket: vi.fn(),
        cancelTurnSpeech: vi.fn(async turnId => {
          expect(turnId).toBe('turn');
          client.sendControl({
            type: 'speech_generate_cancelled', sessionId: 'session', turnId, audioAvailable: true,
          });
          client.close();
        }),
      };
      app.route('/api/ws/speech', speechWebSocketRoute(speech, turns));
    });
    const base = await listen(app, true);
    const socket = new WebSocket(base.replace('http:', 'ws:') + '/api/ws/speech/turn?secret=' + SECRET);
    const frames: SpeechGenerateEvent[] = [];
    socket.on('message', (bytes, isBinary) => {
      expect(isBinary).toBe(false);
      frames.push(JSON.parse(bytes.toString()) as SpeechGenerateEvent);
    });
    await once(socket, 'open');
    await attached;
    socket.send(JSON.stringify({ type: 'speech_generate_cancel' }));
    await once(socket, 'close');
    expect(frames).toEqual([
      { type: 'speech_generate_started', sessionId: 'session', turnId: 'turn' },
      { type: 'speech_generate_cancelled', sessionId: 'session', turnId: 'turn', audioAvailable: true },
    ]);
  });

  it('连接关闭只取消订阅, 不取消合成; 未知 Turn 不连接 Speech', async () => {
    const { turns } = fixture();
    let attached!: () => void;
    let detached!: () => void;
    const attachDone = new Promise<void>(resolve => { attached = resolve; });
    const detachDone = new Promise<void>(resolve => { detached = resolve; });
    const cancel = vi.fn(async () => {});
    const attach = vi.fn(async () => { attached(); });
    const speech: Pick<SpeechComposition, 'attachSpeechSocket' | 'detachSpeechSocket' | 'cancelTurnSpeech'> = {
      attachSpeechSocket: attach,
      detachSpeechSocket(sessionId, turnId) {
        expect([sessionId, turnId]).toEqual(['session', 'turn']);
        detached();
      },
      cancelTurnSpeech: cancel,
    };
    const app = application();
    app.route('/api/ws/speech', speechWebSocketRoute(speech, turns));
    const base = await listen(app, true);
    const url = base.replace('http:', 'ws:') + '/api/ws/speech/';
    const socket = new WebSocket(url + 'turn?secret=' + SECRET);
    await once(socket, 'open');
    await attachDone;
    socket.close();
    await once(socket, 'close');
    await detachDone;
    expect(cancel).not.toHaveBeenCalled();
    const unknown = new WebSocket(url + 'missing?secret=' + SECRET);
    expect((await once(unknown, 'close'))[0]).toBe(1008);
    expect(attach).toHaveBeenCalledTimes(1);
  });
});

describe('Speech HTTP audio', () => {
  it('第一块写完即可读取, 句间停顿保持连接, 文件完成后响应才结束', async () => {
    const { turns, archive } = fixture();
    const writer = await archive.openTurn('session', 'turn', FORMAT);
    await writer.write(Buffer.from([1, 2]));
    const app = application();
    app.route('/api/turns', turnAudioRoute({ audioArchive: archive, turns }));
    const base = await listen(app);
    const response = await fetch(base + '/api/turns/turn/audio?secret=' + SECRET, {
      headers: { Origin: 'http://127.0.0.1:1420' },
    });
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toBe('audio/wav');
    expect(response.headers.get('content-length')).toBeNull();
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(response.headers.get('access-control-allow-origin')).toBe('http://127.0.0.1:1420');
    const reader = response.body!.getReader();
    const first = await reader.read();
    const header = Buffer.from(first.value!);
    expect(header.readUInt32LE(40)).toBe(0xffffffff);
    expect(header.subarray(HEADER_BYTES)).toEqual(Buffer.from([1, 2]));
    const next = reader.read();
    let resolved = false;
    void next.then(() => { resolved = true; });
    await new Promise<void>(resolve => setImmediate(resolve));
    expect(resolved).toBe(false);
    await writer.write(Buffer.from([3, 4]));
    expect(Buffer.from((await next).value!)).toEqual(Buffer.from([3, 4]));
    await writer.finish();
    expect((await reader.read()).done).toBe(true);
    const finalized = await fetch(base + '/api/turns/turn/audio?secret=' + SECRET);
    expect(finalized.headers.get('content-length')).toBe(String(HEADER_BYTES + 4));
    expect(Buffer.from(await finalized.arrayBuffer())).toEqual(Buffer.concat([
      Buffer.from(createPcmWavHeader(FORMAT, 4)), Buffer.from([1, 2, 3, 4]),
    ]));
  });

  it('断开音频请求不取消写盘, 查询参数认证只用于音频 GET', async () => {
    const { turns, archive } = fixture();
    const writer = await archive.openTurn('session', 'turn', FORMAT);
    await writer.write(Buffer.from([1, 2]));
    const app = application();
    app.route('/api/turns', turnAudioRoute({ audioArchive: archive, turns }));
    app.get('/api/sessions', context => context.json({ ok: true }));
    app.post('/api/turns/turn/audio', context => context.json({ ok: true }));
    const base = await listen(app);
    const abort = new AbortController();
    const response = await fetch(base + '/api/turns/turn/audio?secret=' + SECRET, { signal: abort.signal });
    const reader = response.body!.getReader();
    await reader.read();
    const next = reader.read();
    abort.abort();
    await expect(next).rejects.toMatchObject({ name: 'AbortError' });
    await writer.write(Buffer.from([3, 4]));
    expect((await writer.finish())!.byteSize).toBe(HEADER_BYTES + 4);
    expect((await app.request('/api/turns/turn/audio')).status).toBe(401);
    expect((await app.request('/api/turns/turn/audio?secret=wrong')).status).toBe(401);
    expect((await app.request('/api/sessions?secret=' + SECRET)).status).toBe(401);
    expect((await app.request('/api/turns/turn/audio?secret=' + SECRET, { method: 'POST' })).status).toBe(401);
    expect((await app.request('/api/sessions', { headers: { 'X-Ema-Secret': SECRET } })).status).toBe(200);
    expect((await app.request('/api/turns/missing/audio?secret=' + SECRET)).status).toBe(404);
    fs.rmSync(archive.findFinalized('session', 'turn')!.storagePath);
    expect((await app.request('/api/turns/turn/audio?secret=' + SECRET)).status).toBe(404);
  });
});

describe('Speech WAV backup', () => {
  it('文件清理使用整轮 WAV 路径, 保留仍存在的 Turn', async () => {
    const { root, archive } = fixture();
    for (const turnId of ['turn', 'removed']) {
      const writer = await archive.openTurn('session', turnId, FORMAT);
      await writer.write(Buffer.from([1, 2]));
      await writer.finish();
    }
    expect(sweepOrphanTurnFiles(root, () => new Set(['turn']))).toEqual({ removed: 1 });
    expect(archive.findFinalized('session', 'removed')).toBeNull();
    expect(archive.findFinalized('session', 'turn')).not.toBeNull();
    removeTurnFiles(root, 'session', 'turn');
    expect(archive.findFinalized('session', 'turn')).toBeNull();
  });

  it('v8 导出正式 WAV 和真实时长, 恢复到同一音频路径规则, 不打包 pending', async () => {
    const { root, db, archive } = fixture();
    const writer = await archive.openTurn('session', 'turn', FORMAT);
    await writer.write(Buffer.alloc(8000, 1));
    const audio = (await writer.finish())!;
    new SpeechOutputsRepo(db.sqlite).record({ sessionId: 'session', turnId: 'turn', ...audio, createdAt: 2 });
    db.sqlite.prepare('INSERT INTO turns (id, session_id, status, created_at) VALUES (?, ?, ?, ?)')
      .run('waiting', 'session', 'completed', 2);
    const unfinished = await archive.openTurn('session', 'waiting', FORMAT);
    await unfinished.write(Buffer.from([1, 2]));
    const backup = new SessionBackup(
      root, new SessionBackupReader(db.sqlite), new SessionBackupRestorer(db.sqlite), () => true,
    );
    const chunks: Buffer[] = [];
    await backup.exportSession('session')!.writeTo({
      write: async bytes => { chunks.push(Buffer.from(bytes)); },
      complete: async () => {},
      fail: async error => { throw error; },
    });
    await unfinished.finish();
    const bytes = Buffer.concat(chunks);
    const entries = unzipSync(bytes);
    expect(JSON.parse(strFromU8(entries['manifest.json']!)).version).toBe(8);
    const record = JSON.parse(strFromU8(entries['records/speechOutputs.jsonl']!).trim());
    expect(record).toMatchObject({ mimeType: 'audio/wav', byteSize: HEADER_BYTES + 8000, durationMs: 500 });
    expect(record.segmentCount).toBeUndefined();
    expect(Object.keys(entries).filter(name => name.startsWith('files/speechOutputs/'))).toEqual([
      'files/speechOutputs/turn.wav',
    ]);
    expect(entries['files/speechOutputs/turn.wav']).toEqual(new Uint8Array(fs.readFileSync(audio.storagePath)));

    const targetRoot = temporaryRoot();
    const targetDb = database();
    const imported = new SessionBackup(
      targetRoot, new SessionBackupReader(targetDb.sqlite), new SessionBackupRestorer(targetDb.sqlite), () => true,
    );
    await imported.importSession({ declaredBytes: bytes.byteLength, async *chunks() { yield bytes; } });
    const restored = new SpeechOutputsRepo(targetDb.sqlite).listForSession('session');
    expect(restored).toEqual([{
      turn_id: 'turn', session_id: 'session', storage_path: path.join(targetRoot, 'sessions', 'session', 'audio', 'turn.wav'),
      mime_type: 'audio/wav', byte_size: HEADER_BYTES + 8000, duration_ms: 500, created_at: 2,
    }]);
    const targetArchive = new FsAudioArchive(path.join(targetRoot, 'sessions'));
    const read = await targetArchive.openRead('session', 'turn', new AbortController().signal);
    const restoredChunks: Buffer[] = [];
    for await (const chunk of read!.stream) restoredChunks.push(Buffer.from(chunk));
    expect(Buffer.concat(restoredChunks)).toEqual(fs.readFileSync(audio.storagePath));

    const oldManifest = { ...JSON.parse(strFromU8(entries['manifest.json']!)), version: 7 };
    entries['manifest.json'] = strToU8(JSON.stringify(oldManifest));
    const oldBytes = zipSync(entries);
    const rejectedDb = database();
    const rejected = new SessionBackup(
      temporaryRoot(), new SessionBackupReader(rejectedDb.sqlite), new SessionBackupRestorer(rejectedDb.sqlite), () => true,
    );
    await expect(rejected.importSession({
      declaredBytes: oldBytes.byteLength, async *chunks() { yield oldBytes; },
    })).rejects.toMatchObject({ code: 'unsupported_version' });
    expect(rejectedDb.sqlite.prepare('SELECT id FROM sessions').all()).toEqual([]);
  });
});
