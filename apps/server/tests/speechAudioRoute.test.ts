import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Hono } from 'hono';
import { afterEach, expect, it, vi } from 'vitest';
import { Database } from '@ema-agent/storage';
import { AudioStore } from '@ema-agent/speech';
import { audioRoute } from '../src/routes/audio.js';
import { emaAuth } from '../src/platform/auth.js';

const resources: Array<{ database: Database; root: string }> = [];
const secret = 'audio-route-fixture-secret-1234567890';
const headers = { 'X-Ema-Secret': secret };

afterEach(() => {
  vi.restoreAllMocks();
  for (const { database, root } of resources.splice(0)) {
    database.close();
    if (path.dirname(path.resolve(root)) !== path.resolve(os.tmpdir())) throw new Error('Unexpected temporary directory');
    fs.rmSync(root, { recursive: true, force: true });
  }
});

async function fixture() {
  const database = new Database({ memory: true, kind: 'data' });
  await database.migrate();
  database.sqlite.exec(`
    INSERT INTO sessions (id, title, cwd, created_at, updated_at) VALUES ('session', 'S', '.', 1, 1);
    INSERT INTO turns (id, session_id, status, created_at) VALUES ('turn', 'session', 'completed', 1);
  `);
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ema-speech-http-'));
  resources.push({ database, root });
  const audioStore = new AudioStore(database, root, () => {});
  const app = new Hono().use('*', emaAuth(secret)).route('/api/audio', audioRoute(audioStore));
  const identity = { audioId: 'first', sessionId: 'session', turnId: 'turn', characterName: '艾玛' };
  audioStore.createAudioRecord(identity);
  const format = { sampleRate: 8000, channelCount: 1 };
  return { app, audioStore, identity, format };
}

it('实时读取临时 WAV, 写完后以同一 ID 重播和读取段表', async () => {
  const { app, audioStore, identity, format } = await fixture();
  await audioStore.files.appendPCM(identity, format, Buffer.from([1, 2]));
  audioStore.segments.beginGeneration(identity.audioId);
  audioStore.segments.beginSegment(identity.audioId, '第一段', 0);
  const response = await app.request('/api/audio/first/file?secret=' + secret);
  expect(response.status).toBe(200);
  expect(response.headers.get('Content-Length')).toBeNull();
  const reader = response.body!.getReader();
  expect((await reader.read()).value?.length).toBe(46);
  const nextChunk = reader.read();
  await audioStore.files.appendPCM(identity, format, Buffer.from([3, 4]));
  expect(Array.from((await nextChunk).value!)).toEqual([3, 4]);
  audioStore.segments.finishSegment(identity.audioId, 0, 0.25);
  await audioStore.saveCompletedAudio(identity.audioId, audioStore.segments.getCompletedSegments(identity.audioId));
  audioStore.segments.releaseGeneration(identity.audioId);
  expect((await reader.read()).done).toBe(true);
  const playback = await app.request('/api/audio/first/playback', { headers });
  expect(await playback.json()).toMatchObject({ audioId: 'first', segments: [{ textForTTS: '第一段', endMs: 0.25 }] });
  const replay = await app.request('/api/audio/first/file?secret=' + secret);
  expect(replay.headers.get('Content-Length')).toBe('48');
  expect((await replay.arrayBuffer()).byteLength).toBe(48);
  expect((await app.request('/api/audio/first/playback?secret=' + secret)).status).toBe(401);
});

it('生成中拒绝删除, 结束后按 ID 删除文件记录和字幕, 重复删除可安全完成', async () => {
  const { app, audioStore, identity, format } = await fixture();
  expect((await app.request('/api/audio/first', { method: 'DELETE', headers })).status).toBe(409);
  await audioStore.files.appendPCM(identity, format, Buffer.from([1, 2]));
  await audioStore.saveCompletedAudio(identity.audioId, []);
  const record = audioStore.outputs.findByAudioId(identity.audioId)!;
  expect((await app.request('/api/audio/first', { method: 'DELETE', headers })).status).toBe(204);
  expect(fs.existsSync(record.storagePath)).toBe(false);
  expect((await app.request('/api/audio/first/playback', { headers })).status).toBe(404);
  expect((await app.request('/api/audio/first/file?secret=' + secret)).status).toBe(404);
  expect((await app.request('/api/audio/first', { method: 'DELETE', headers })).status).toBe(204);
});

it('文件删除失败返回具体错误并保留 failed 记录供重试', async () => {
  const { app, audioStore, identity, format } = await fixture();
  await audioStore.files.appendPCM(identity, format, Buffer.from([1, 2]));
  await audioStore.saveCompletedAudio(identity.audioId, []);
  vi.spyOn(audioStore.files, 'deleteFile').mockRejectedValueOnce(new Error('file is busy'));
  const deletion = await app.request('/api/audio/first', { method: 'DELETE', headers });
  expect(deletion.status).toBe(500);
  expect(await deletion.json()).toMatchObject({ message: 'file is busy' });
  const record = await app.request('/api/audio/first', { headers });
  expect(await record.json()).toMatchObject({ audioStatus: 'failed', failureMessage: expect.stringContaining('file is busy') });
});

it('文件写完但尚未标记 ready 时, 已启动的实时读取仍可结束', async () => {
  const { app, audioStore, identity, format } = await fixture();
  await audioStore.files.appendPCM(identity, format, Buffer.from([1, 2]));
  const response = await app.request('/api/audio/first/file?secret=' + secret);
  const reader = response.body!.getReader();
  await reader.read();
  const endOfStream = reader.read();
  await audioStore.files.finishWrite(identity.audioId);
  expect((await endOfStream).done).toBe(true);
  expect(audioStore.outputs.findByAudioId(identity.audioId)?.audioStatus).toBe('generating');
});
