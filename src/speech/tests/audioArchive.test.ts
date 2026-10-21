import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { once } from 'node:events';
import { finished } from 'node:stream/promises';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createPcmWavHeader, type CallTTS } from '@ema-agent/tts';
import { UsageRecorder } from '@ema-agent/usage';
import { Database } from '../../storage/index.js';
import { FsAudioArchive } from '../audioArchive.js';
import { SpeechCoordinator, type SpeechCoordinatorArgs } from '../speechCoordinator.js';

const FORMAT = { sampleRate: 8000, channelCount: 1 };
const HEADER_BYTES = createPcmWavHeader(FORMAT, 0).byteLength;
const roots: string[] = [];
const databases: Database[] = [];

afterEach(() => {
  for (const db of databases.splice(0)) db.close();
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

function createArchive(): { archive: FsAudioArchive; root: string } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ema-speech-wav-'));
  roots.push(root);
  return { archive: new FsAudioArchive(root), root };
}

function createCoordinator(callTTS: CallTTS, onAudioReady = () => {}, onSentenceError = (_error: {
  readonly code: string;
  readonly message: string;
}) => {}, overrides: Partial<SpeechCoordinatorArgs> = {}) {
  const { archive, root } = createArchive();
  const db = new Database({ memory: true, kind: 'data' });
  databases.push(db);
  db.migrate();
  db.sqlite.prepare(`INSERT INTO sessions (id, title, cwd, last_activity_at, created_at, updated_at)
    VALUES ('s', '语音测试', 'D:/work', 1, 1, 1)`).run();
  db.sqlite.prepare(`INSERT INTO turns (id, session_id, status, created_at)
    VALUES ('t', 's', 'completed', 1)`).run();
  const usageRecorder = new UsageRecorder(db);
  const coordinator = new SpeechCoordinator({
    sessionId: 's',
    turnId: 't',
    providerId: 'provider',
    modelId: 'model',
    voice: { kind: 'provider', id: 'voice' },
    callTTS,
    openAudio: format => archive.openTurn('s', 't', '艾玛', format),
    signal: new AbortController().signal,
    usageRecorder,
    savePartialAudio: true,
    saveAudioRecord: () => {},
    onAudioReady,
    onSentenceError,
    ...overrides,
  });
  return { archive, root, coordinator, usageRecorder };
}

describe('FsAudioArchive', () => {
  it('同轮按完整角色名保存, 只替换选定角色, 读取不会串到其他角色的写入', async () => {
    const { archive, root } = createArchive();
    const first = await archive.openTurn('s', 't', '艾玛', FORMAT);
    await first.write(Buffer.from([1, 2]));
    const original = (await first.finish(() => {}))!;
    const other = await archive.openTurn('s', 't', '希罗-测试', FORMAT);
    await other.write(Buffer.from([3, 4]));
    expect(await archive.openRead('s', 't', '没有音频', new AbortController().signal)).toBeNull();
    const otherAudio = (await other.finish(() => {}))!;
    expect(archive.characterNameFor('t', otherAudio.storagePath)).toBe('希罗-测试');
    const replacement = await archive.openTurn('s', 't', '艾玛', FORMAT);
    await replacement.write(Buffer.from([5, 6]));
    await replacement.finish(() => {});
    expect(fs.readFileSync(original.storagePath).subarray(HEADER_BYTES)).toEqual(Buffer.from([5, 6]));
    expect(fs.readFileSync(otherAudio.storagePath).subarray(HEADER_BYTES)).toEqual(Buffer.from([3, 4]));
    expect(fs.readdirSync(path.join(root, 's', 't')).sort()).toEqual([
      't-希罗-测试.wav', 't-艾玛.wav',
    ].sort());
  });

  it('连续追加 PCM, 完成后只有一份带真实长度和时长的 WAV', async () => {
    const { archive, root } = createArchive();
    const writer = await archive.openTurn('s', 't', '艾玛', FORMAT);
    const first = Buffer.alloc(8000, 1);
    const second = Buffer.alloc(4000, 2);
    await writer.write(first);
    await writer.write(second);
    expect(archive.findFinalized('s', 't', '艾玛')).toBeNull();

    const finishing = writer.finish(() => {});
    expect(writer.finish(() => {})).toBe(finishing);
    const audio = await finishing;
    expect(audio).toMatchObject({
      mimeType: 'audio/wav',
      byteSize: HEADER_BYTES + 12000,
      durationMs: 750,
    });
    const bytes = fs.readFileSync(audio!.storagePath);
    expect(bytes.subarray(0, HEADER_BYTES)).toEqual(Buffer.from(createPcmWavHeader(FORMAT, 12000)));
    expect(bytes.subarray(HEADER_BYTES)).toEqual(Buffer.concat([first, second]));
    expect(fs.readdirSync(path.join(root, 's', 't'))).toEqual(['t-艾玛.wav']);
    expect(archive.findFinalized('s', 't', '艾玛')?.storagePath).toBe(audio!.storagePath);
  });

  it('读取等待下一次写入, 句间停顿不是 EOF, 完成后读取正常结束', async () => {
    const { archive } = createArchive();
    const writer = await archive.openTurn('s', 't', '艾玛', FORMAT);
    await writer.write(Buffer.from([1, 2]));
    const audio = await archive.openRead('s', 't', '艾玛', new AbortController().signal);
    expect(audio!.byteSize).toBeNull();
    const iterator = audio!.stream[Symbol.asyncIterator]();
    const first = await iterator.next();
    const bytes = Buffer.from(first.value);
    expect(bytes.readUInt32LE(40)).toBe(0xffffffff);
    expect(bytes.subarray(HEADER_BYTES)).toEqual(Buffer.from([1, 2]));

    const next = iterator.next();
    let received = false;
    void next.then(() => { received = true; });
    await new Promise<void>(resolve => setImmediate(resolve));
    expect(received).toBe(false);
    await writer.write(Buffer.from([3, 4]));
    expect(Buffer.from((await next).value)).toEqual(Buffer.from([3, 4]));
    await writer.finish(() => {});
    expect((await iterator.next()).done).toBe(true);

    const finalized = await archive.openRead('s', 't', '艾玛', new AbortController().signal);
    expect(finalized!.byteSize).toBe(HEADER_BYTES + 4);
    finalized!.stream.destroy();
    await finished(finalized!.stream).catch(() => undefined);
  });

  it('关闭读取流解除文件末尾等待, 后续写入仍然完成', async () => {
    const { archive } = createArchive();
    const writer = await archive.openTurn('s', 't', '艾玛', FORMAT);
    await writer.write(Buffer.from([1, 2]));
    const audio = await archive.openRead('s', 't', '艾玛', new AbortController().signal);
    const iterator = audio!.stream[Symbol.asyncIterator]();
    await iterator.next();
    const closed = once(audio!.stream, 'close');
    audio!.stream.destroy();
    await closed;
    await writer.write(Buffer.from([3, 4]));
    const result = await writer.finish(() => {});
    expect(fs.readFileSync(result!.storagePath).subarray(HEADER_BYTES)).toEqual(Buffer.from([1, 2, 3, 4]));
  });

  it('请求取消只结束读取, 不取消音频写入', async () => {
    const { archive } = createArchive();
    const writer = await archive.openTurn('s', 't', '艾玛', FORMAT);
    await writer.write(Buffer.from([1, 2]));
    const abort = new AbortController();
    const audio = await archive.openRead('s', 't', '艾玛', abort.signal);
    audio!.stream.resume();
    const reading = finished(audio!.stream);
    abort.abort();
    await expect(reading).rejects.toMatchObject({ name: 'AbortError' });
    await writer.write(Buffer.from([3, 4]));
    expect((await writer.finish(() => {}))!.byteSize).toBe(HEADER_BYTES + 4);
  });

  it('没有 PCM 时删除空 pending 文件, 不发布正式音频', async () => {
    const { archive, root } = createArchive();
    const writer = await archive.openTurn('s', 't', '艾玛', FORMAT);
    expect(await writer.finish(() => {})).toBeNull();
    expect(archive.findFinalized('s', 't', '艾玛')).toBeNull();
    expect(fs.readdirSync(path.join(root, 's', 't'))).toEqual([]);
    expect(await archive.openRead('s', 'missing', '艾玛', new AbortController().signal)).toBeNull();
  });

  it('替代音频未保存时仍可读取旧文件; 丢弃后旧音频不变', async () => {
    const { archive, root } = createArchive();
    const first = await archive.openTurn('s', 't', '艾玛', FORMAT);
    await first.write(Buffer.from([1, 2]));
    const original = (await first.finish(() => {}))!;
    const second = await archive.openTurn('s', 't', '艾玛', FORMAT);
    await second.write(Buffer.from([3, 4]));
    const read = (await archive.openRead('s', 't', '艾玛', new AbortController().signal))!;
    const chunks: Buffer[] = [];
    for await (const chunk of read.stream) chunks.push(Buffer.from(chunk));
    expect(Buffer.concat(chunks).subarray(HEADER_BYTES)).toEqual(Buffer.from([1, 2]));
    await second.discard();
    expect(fs.readFileSync(original.storagePath).subarray(HEADER_BYTES)).toEqual(Buffer.from([1, 2]));
    expect(fs.readdirSync(path.join(root, 's', 't'))).toEqual(['t-艾玛.wav']);
  });

  it('记录保存失败则恢复旧 WAV, 不保留新文件或 pending', async () => {
    const { archive, root } = createArchive();
    const original = await archive.openTurn('s', 't', '艾玛', FORMAT);
    await original.write(Buffer.from([1, 2]));
    const saved = (await original.finish(() => {}))!;
    const bytes = fs.readFileSync(saved.storagePath);
    const replacement = await archive.openTurn('s', 't', '艾玛', FORMAT);
    await replacement.write(Buffer.from([3, 4, 5, 6]));
    await expect(replacement.finish(() => { throw new Error('SQL rejected'); })).rejects.toThrow('SQL rejected');
    expect(fs.readFileSync(saved.storagePath)).toEqual(bytes);
    expect(fs.readdirSync(path.join(root, 's', 't'))).toEqual(['t-艾玛.wav']);
  });

  it('首次生成的记录保存失败时也撤回正式文件', async () => {
    const { archive, root } = createArchive();
    const writer = await archive.openTurn('s', 't', '艾玛', FORMAT);
    await writer.write(Buffer.from([1, 2]));
    await expect(writer.finish(() => { throw new Error('SQL rejected'); })).rejects.toThrow('SQL rejected');
    expect(archive.findFinalized('s', 't', '艾玛')).toBeNull();
    expect(fs.readdirSync(path.join(root, 's', 't'))).toEqual([]);
  });
});

describe('SpeechCoordinator', () => {
  it('没有播放器也能生成四句并写入一个 WAV, 只通知一次可读状态', async () => {
    const sentences: string[] = [];
    let readyCount = 0;
    const { coordinator, usageRecorder } = createCoordinator(async function* (request) {
      sentences.push(request.text);
      yield { type: 'audio_started', ...FORMAT };
      yield { type: 'audio_chunk', bytes: Buffer.from([1, 2]) };
      yield { type: 'done', totalBytes: 2, firstByteMs: 0 };
    }, () => { readyCount += 1; });
    coordinator.acceptTextDelta('第一句话。第二句话。第三句话。第四句话。');
    const result = await coordinator.finish();
    expect(result.status).toBe('completed');
    expect(sentences).toHaveLength(4);
    expect(readyCount).toBe(1);
    expect(fs.readFileSync(result.audio!.storagePath).subarray(HEADER_BYTES)).toEqual(Buffer.from([1, 2, 1, 2, 1, 2, 1, 2]));
    expect(usageRecorder.forTurn('t')).toHaveLength(4);
  });

  it('取消中断当前合成, 跳过剩余句子, 保存已经生成的部分', async () => {
    let ready!: () => void;
    const readable = new Promise<void>(resolve => { ready = resolve; });
    const sentences: string[] = [];
    const { coordinator, usageRecorder } = createCoordinator(async function* (request) {
      sentences.push(request.text);
      yield { type: 'audio_started', ...FORMAT };
      yield { type: 'audio_chunk', bytes: Buffer.from([1, 2, 3, 4]) };
      request.signal!.throwIfAborted();
      await new Promise<void>(resolve => request.signal!.addEventListener('abort', () => resolve(), { once: true }));
      request.signal!.throwIfAborted();
    }, ready);
    coordinator.acceptTextDelta('第一句话。第二句话。');
    await readable;
    const finishing = coordinator.finish();
    const cancelled = coordinator.cancel();
    expect(cancelled).toBe(finishing);
    const result = await cancelled;
    expect(result.status).toBe('cancelled');
    expect(sentences).toHaveLength(1);
    expect(fs.readFileSync(result.audio!.storagePath).subarray(HEADER_BYTES)).toEqual(Buffer.from([1, 2, 3, 4]));
    expect(usageRecorder.forTurn('t')[0]!.status).toBe('cancelled');
  });

  it('单句供应商失败发出提示, 仍可生成后面的句子', async () => {
    let calls = 0;
    const warnings: string[] = [];
    const { coordinator } = createCoordinator(async function* () {
      calls += 1;
      if (calls === 1) throw new Error('provider failed');
      yield { type: 'audio_started', ...FORMAT };
      yield { type: 'audio_chunk', bytes: Buffer.from([1, 2]) };
    }, () => {}, error => warnings.push(error.message));
    coordinator.acceptTextDelta('第一句话。第二句话。');
    const result = await coordinator.finish();
    expect(result.status).toBe('completed');
    expect(warnings).toEqual(['provider failed']);
    expect(result.audio).not.toBeNull();
  });

  it('后续句子的 PCM 格式不同则停止追加, 保留前面的音频', async () => {
    let calls = 0;
    const { coordinator } = createCoordinator(async function* () {
      calls += 1;
      yield { type: 'audio_started', sampleRate: calls === 1 ? 8000 : 16000, channelCount: 1 };
      yield { type: 'audio_chunk', bytes: Buffer.from([1, 2]) };
    });
    coordinator.acceptTextDelta('第一句话。第二句话。第三句话。');
    const result = await coordinator.finish();
    expect(result).toMatchObject({ status: 'failed', code: 'speech/generate_failed' });
    expect(calls).toBe(2);
    expect(fs.readFileSync(result.audio!.storagePath).subarray(HEADER_BYTES)).toEqual(Buffer.from([1, 2]));
  });

  it('无可朗读文字时不创建音频文件', async () => {
    const { coordinator, root } = createCoordinator(async function* () {
      throw new Error('should not synthesize');
    });
    expect(await coordinator.finish()).toEqual({ status: 'completed', audio: null });
    expect(fs.existsSync(path.join(root, 's'))).toBe(false);
  });

  it('同一 Turn 重复生成时, 每次真实 TTS 请求均有独立用量 ID', async () => {
    const callTTS: CallTTS = async function* () {
      yield { type: 'audio_started', ...FORMAT };
      yield { type: 'audio_chunk', bytes: Buffer.from([1, 2]) };
    };
    const { coordinator, archive, usageRecorder } = createCoordinator(callTTS);
    coordinator.acceptTextDelta('第一句。第二句。');
    await coordinator.finish();
    const second = new SpeechCoordinator({
      sessionId: 's', turnId: 't', providerId: 'provider', modelId: 'model',
      voice: { kind: 'provider', id: 'voice' },
      callTTS,
      openAudio: format => archive.openTurn('s', 't', '艾玛', format),
      usageRecorder,
      signal: new AbortController().signal,
      savePartialAudio: false,
      saveAudioRecord: () => {},
      onAudioReady: () => {},
      onSentenceError: () => {},
    });
    second.acceptTextDelta('第一句。第二句。');
    await second.finish();
    const records = usageRecorder.forTurn('t');
    expect(records).toHaveLength(4);
    expect(new Set(records.map(record => record.id)).size).toBe(4);
    expect(records.every(record => record.unit === 'character' && record.quantity === 4)).toBe(true);
  });

  it('手动整轮生成有一句失败就丢弃本次音频, 不保存半轮文件', async () => {
    let calls = 0;
    const save = vi.fn();
    const { coordinator, archive } = createCoordinator(async function* () {
      calls += 1;
      if (calls === 2) throw new Error('second sentence failed');
      yield { type: 'audio_started', ...FORMAT };
      yield { type: 'audio_chunk', bytes: Buffer.from([1, 2]) };
    }, () => {}, () => {}, { savePartialAudio: false, saveAudioRecord: save });
    coordinator.acceptTextDelta('第一句。第二句。第三句。');
    expect(await coordinator.finish()).toMatchObject({ status: 'failed', audio: null });
    expect(calls).toBe(2);
    expect(save).not.toHaveBeenCalled();
    expect(archive.findFinalized('s', 't', '艾玛')).toBeNull();
  });

  it('手动生成取消后删除已经写入的部分', async () => {
    let ready!: () => void;
    const readable = new Promise<void>(resolve => { ready = resolve; });
    const { coordinator, archive } = createCoordinator(async function* (request) {
      yield { type: 'audio_started', ...FORMAT };
      yield { type: 'audio_chunk', bytes: Buffer.from([1, 2]) };
      request.signal!.throwIfAborted();
      await new Promise<void>(resolve => request.signal!.addEventListener('abort', () => resolve(), { once: true }));
      request.signal!.throwIfAborted();
    }, ready, () => {}, { savePartialAudio: false });
    coordinator.acceptTextDelta('第一句。');
    const finished = coordinator.finish();
    await readable;
    await coordinator.cancel();
    expect(await finished).toEqual({ status: 'cancelled', audio: null });
    expect(archive.findFinalized('s', 't', '艾玛')).toBeNull();
  });
});
