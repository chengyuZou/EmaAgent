import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { finished } from 'node:stream/promises';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Database, SpeechOutputsRepo, SpeechSegmentsRepo } from '@ema-agent/storage';
import { UsageRecorder } from '@ema-agent/usage';
import type { TTSRequest, TTSStreamEvent } from '@ema-agent/tts';
import { AudioStore } from '../store/audioStore.js';
import { SpeechGenerator, type StartTurnSpeechInput } from '../speechGenerator.js';
import type { SpeechEvent } from '../events.js';

const provider = vi.hoisted(() => ({ synthesize: vi.fn(), register: vi.fn() }));
vi.mock('@ema-agent/tts', async importOriginal => ({
  ...await importOriginal<typeof import('@ema-agent/tts')>(),
  createTTSCall: () => provider.synthesize,
  createTTSVoiceRegistrar: () => provider.register,
}));

const format = { sampleRate: 8000, channelCount: 1 };
const openDatabases: Database[] = [];
const temporaryDirectories: string[] = [];
const generators: SpeechGenerator[] = [];
const input: StartTurnSpeechInput = {
  sessionId: 'session', turnId: 'turn', characterName: '希罗-test',
  providerId: 'provider', modelId: 'model',
  connection: { protocol: 'gpt-sovits-tts' },
  voiceReference: {
    kind: 'reference', resourceName: 'reference.wav', resourceUpdatedAt: 1,
    registrationName: 'fixture', audioPath: 'reference.wav', promptText: '参考', promptLanguage: 'zh',
  },
};

async function* produceAudio(): AsyncGenerator<TTSStreamEvent> {
  yield { type: 'audio_started', ...format };
  yield { type: 'audio_chunk', bytes: Buffer.alloc(8000, 1) };
  yield { type: 'done', totalBytes: 8000, firstByteMs: 0 };
}

beforeEach(() => {
  provider.synthesize.mockReset().mockImplementation(produceAudio);
  provider.register.mockReset().mockResolvedValue({ kind: 'provider', id: 'voice' });
});
afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(generators.splice(0).map(generator => generator.close()));
  for (const database of openDatabases.splice(0)) database.close();
  for (const directory of temporaryDirectories.splice(0)) {
    if (path.dirname(path.resolve(directory)) !== path.resolve(os.tmpdir())) throw new Error('Unexpected temporary directory');
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

async function createFixture() {
  const database = new Database({ memory: true, kind: 'data' });
  openDatabases.push(database);
  await database.migrate();
  database.sqlite.exec(`
    INSERT INTO sessions (id, title, cwd, created_at, updated_at) VALUES ('session', '语音', '.', 1, 1);
    INSERT INTO turns (id, session_id, status, created_at)
      VALUES ('turn', 'session', 'completed', 1), ('another', 'session', 'completed', 2);
  `);
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'ema-speech-'));
  temporaryDirectories.push(directory);
  const events: SpeechEvent[] = [];
  const savedStatusesAtNotification: Array<string | undefined> = [];
  const audioStore = new AudioStore(database, path.join(directory, 'audio'), event => {
    savedStatusesAtNotification.push(
      database.sqlite.prepare('SELECT audio_status FROM speech_outputs WHERE audio_id = ?')
        .get(event.audioId)?.audio_status,
    );
    events.push(event);
  });
  const usage = new UsageRecorder(database);
  const generator = new SpeechGenerator(audioStore, usage, event => { events.push(event); });
  generators.push(generator);
  return { database, directory, audioStore, events, usage, generator, savedStatusesAtNotification };
}

describe('SpeechGenerator', () => {
  it('先登记再准备声音, 返回同一个对象, 完成时保存段表后通知 ready', async () => {
    const { generator, audioStore, events, usage, savedStatusesAtNotification } = await createFixture();
    const speechGeneration = generator.startTurnSpeech(input);
    expect(generator.findTurnGeneration(input.turnId)).toBe(speechGeneration);
    expect(audioStore.outputs.findByAudioId(speechGeneration.audioId)?.audioStatus).toBe('generating');
    generator.appendTextDelta(speechGeneration.audioId, '第一句话。第二句话。');
    generator.endTextInput(speechGeneration.audioId);
    const result = await speechGeneration.generationCompletion;
    expect(result).toMatchObject({ status: 'completed', audioAvailable: true });
    const savedAudio = audioStore.outputs.findByAudioId(result.audioId)!;
    expect(savedAudio.durationMs).toBe(1000);
    expect(path.basename(savedAudio.storagePath)).toBe(input.characterName + '-' + result.audioId + '.wav');
    expect(fs.existsSync(savedAudio.storagePath + '.tmp')).toBe(false);
    expect(audioStore.segments.getSegments(result.audioId)).toEqual([
      { segmentIndex: 0, textForTTS: '第一句话。', startMs: 0, endMs: 500 },
      { segmentIndex: 1, textForTTS: '第二句话。', startMs: 500, endMs: 1000 },
    ]);
    expect(savedStatusesAtNotification).toEqual(['generating', 'ready']);
    expect(events.slice(-2).map(event => event.type)).toEqual(['session_audio_changed', 'speech_generate_completed']);
    expect(usage.forTurn(input.turnId)).toHaveLength(2);
    expect(generator.findTurnGeneration(input.turnId)).toBeNull();
  });

  it('登记 SQL 失败时不请求声音或创建文件', async () => {
    const { generator, directory } = await createFixture();
    vi.spyOn(SpeechOutputsRepo.prototype, 'insertAudio').mockImplementationOnce(() => { throw new Error('SQL rejected'); });
    expect(() => generator.startTurnSpeech(input)).toThrow('SQL rejected');
    await Promise.resolve();
    expect(provider.register).not.toHaveBeenCalled();
    expect(provider.synthesize).not.toHaveBeenCalled();
    expect(fs.readdirSync(directory)).toEqual([]);
  });

  it('磁盘上已有同一 ID 的 WAV 时不登记或覆盖它', async () => {
    const { generator, audioStore } = await createFixture();
    const generationResult = await generator.generateTurnAudio(input, '保留这段音频。');
    const audioRecord = audioStore.outputs.findByAudioId(generationResult.audioId)!;
    const originalBytes = fs.readFileSync(audioRecord.storagePath);
    audioStore.outputs.deleteAudioRecord(generationResult.audioId);
    expect(() => audioStore.createAudioRecord(audioRecord)).toThrow('不会覆盖');
    expect(fs.readFileSync(audioRecord.storagePath)).toEqual(originalBytes);
    expect(audioStore.outputs.findByAudioId(generationResult.audioId)).toBeNull();
  });

  it('同角色多次生成都保留, 不覆盖其他 AudioID 或角色', async () => {
    const { generator, audioStore } = await createFixture();
    const first = await generator.generateTurnAudio(input, '第一条音频。');
    const second = await generator.generateTurnAudio(input, '第二条音频。');
    await generator.generateTurnAudio({ ...input, characterName: '艾玛' }, '另一角色。');
    expect(audioStore.listAudioSummaries(input.turnId, input.characterName)).toHaveLength(2);
    expect(audioStore.listAudioSummaries(input.turnId)).toHaveLength(3);
    const firstAudio = audioStore.outputs.findByAudioId(first.audioId)!;
    const secondAudio = audioStore.outputs.findByAudioId(second.audioId)!;
    expect(firstAudio.storagePath).not.toBe(secondAudio.storagePath);
    expect(fs.existsSync(firstAudio.storagePath)).toBe(true);
    expect(audioStore.segments.getSegments(first.audioId)[0]?.textForTTS).toBe('第一条音频。');
  });

  it('手动失败清理本次文件和记录, 旧音频保留', async () => {
    const { generator, audioStore, savedStatusesAtNotification } = await createFixture();
    const original = await generator.generateTurnAudio(input, '旧音频。');
    provider.synthesize.mockImplementationOnce(async function* () { throw new Error('provider failed'); });
    const failed = await generator.generateTurnAudio(input, '新的内容。');
    expect(failed).toMatchObject({ status: 'failed', audioAvailable: false });
    expect(audioStore.outputs.findByAudioId(failed.audioId)).toBeNull();
    expect(audioStore.outputs.findByAudioId(original.audioId)?.audioStatus).toBe('ready');
    expect(savedStatusesAtNotification.at(-1)).toBeUndefined();
  });

  it('生成失败且文件清理失败时保存 failed, 释放活跃任务后通知终态', async () => {
    const { generator, audioStore, events } = await createFixture();
    provider.synthesize.mockImplementationOnce(async function* () {
      yield { type: 'audio_started', ...format };
      yield { type: 'audio_chunk', bytes: Buffer.alloc(4000) };
      throw new Error('provider failed');
    });
    vi.spyOn(audioStore.files, 'deleteFile').mockRejectedValueOnce(new Error('file is busy'));
    const result = await generator.generateTurnAudio(input, '失败的内容。');
    const failedAudio = audioStore.outputs.findByAudioId(result.audioId)!;
    expect(failedAudio.audioStatus).toBe('failed');
    expect(failedAudio.failureMessage).toContain('清理未完成');
    expect(generator.findTurnGeneration(input.turnId)).toBeNull();
    expect(events.at(-1)?.type).toBe('speech_generate_failed');
    expect(generator.getAudioPlayback(result.audioId)).toBeNull();
    await audioStore.deleteAudio(result.audioId);
    expect(audioStore.outputs.findByAudioId(result.audioId)).toBeNull();
  });

  it('清理和状态保存同时失败也结束任务, 下次启动再将遗留 generating 改为 failed', async () => {
    const { generator, audioStore } = await createFixture();
    provider.register.mockRejectedValueOnce(new Error('voice failed'));
    vi.spyOn(audioStore.files, 'deleteFile').mockRejectedValueOnce(new Error('file is busy'));
    vi.spyOn(audioStore.outputs, 'updateAudioStatus').mockImplementationOnce(() => { throw new Error('SQL failed'); });
    const result = await generator.generateTurnAudio(input, '内容。');
    expect(result.status).toBe('failed');
    expect(result).toMatchObject({ code: 'speech/audio_status_save_failed', message: expect.stringContaining('未能保存') });
    expect(generator.findTurnGeneration(input.turnId)).toBeNull();
    expect(audioStore.outputs.findByAudioId(result.audioId)?.audioStatus).toBe('generating');
    audioStore.markInterruptedAudioRecordsFailed();
    expect(audioStore.outputs.findByAudioId(result.audioId)?.audioStatus).toBe('failed');
  });

  it('取消自动语音保留已写 PCM, 手动取消不保留本次音频', async () => {
    const { generator, audioStore } = await createFixture();
    let acknowledgeChunk!: () => void;
    let chunkWritten = new Promise<void>(resolve => { acknowledgeChunk = resolve; });
    provider.synthesize.mockImplementation(async function* (request: TTSRequest) {
      yield { type: 'audio_started', ...format };
      yield { type: 'audio_chunk', bytes: Buffer.alloc(4000) };
      acknowledgeChunk();
      await new Promise<void>(resolve => request.signal!.addEventListener('abort', () => resolve(), { once: true }));
      request.signal!.throwIfAborted();
    });
    const automatic = generator.startTurnSpeech(input);
    generator.appendTextDelta(automatic.audioId, '自动生成的内容。');
    await chunkWritten;
    await generator.cancelGeneration(automatic.audioId);
    expect(await automatic.generationCompletion).toMatchObject({ status: 'cancelled', audioAvailable: true });
    expect(audioStore.outputs.findByAudioId(automatic.audioId)?.durationMs).toBe(250);
    chunkWritten = new Promise<void>(resolve => { acknowledgeChunk = resolve; });
    const manualCompletion = generator.generateTurnAudio(input, '手动生成的内容。');
    await chunkWritten;
    const manual = generator.findTurnGeneration(input.turnId)!;
    await generator.cancelGeneration(manual.audioId);
    expect(await manualCompletion).toMatchObject({ status: 'cancelled', audioAvailable: false });
    expect(audioStore.outputs.findByAudioId(manual.audioId)).toBeNull();
  });

  it('准备声音期间可以取消, 同一 Turn 不重复生成, 空正文会移除登记', async () => {
    const { generator, audioStore } = await createFixture();
    provider.register.mockImplementationOnce((_reference, signal: AbortSignal) => new Promise((_resolve, reject) => {
      if (signal.aborted) reject(signal.reason);
      else signal.addEventListener('abort', () => reject(signal.reason), { once: true });
    }));
    const preparing = generator.startTurnSpeech(input);
    expect(() => generator.startTurnSpeech(input)).toThrow('该轮正在生成');
    await generator.cancelSessionSpeech(input.sessionId);
    expect((await preparing.generationCompletion).status).toBe('cancelled');
    const empty = generator.startTurnSpeech(input);
    generator.endTextInput(empty.audioId);
    expect(await empty.generationCompletion).toMatchObject({ status: 'completed', audioAvailable: false });
    expect(audioStore.listAudioSummaries(input.turnId)).toEqual([]);
  });
});

describe('AudioStore', () => {
  it('临时文件支持边写边读, 关闭写入后读者结束且无须等待 SQL', async () => {
    const { audioStore } = await createFixture();
    const identity = { audioId: 'growing', sessionId: input.sessionId, turnId: input.turnId, characterName: input.characterName };
    audioStore.createAudioRecord(identity);
    await audioStore.files.appendPCM(identity, format, Buffer.from([1, 2]));
    const audioRecord = audioStore.outputs.findByAudioId(identity.audioId)!;
    expect(fs.existsSync(audioRecord.storagePath + '.tmp')).toBe(true);
    expect(fs.existsSync(audioRecord.storagePath)).toBe(false);
    const audioRead = (await audioStore.openRead(identity.audioId, new AbortController().signal))!;
    const iterator = audioRead.stream[Symbol.asyncIterator]();
    expect(Buffer.from((await iterator.next()).value).length).toBe(46);
    const nextChunk = iterator.next();
    await audioStore.files.appendPCM(identity, format, Buffer.from([3, 4]));
    expect(Buffer.from((await nextChunk).value)).toEqual(Buffer.from([3, 4]));
    const endOfStream = iterator.next();
    await audioStore.files.finishWrite(identity.audioId);
    expect((await endOfStream).done).toBe(true);
    expect(audioStore.outputs.findByAudioId(identity.audioId)?.audioStatus).toBe('generating');
    const completedRead = (await audioStore.openRead(identity.audioId, new AbortController().signal))!;
    expect(completedRead.byteSize).toBe(48);
    completedRead.stream.resume();
    await finished(completedRead.stream);
  });

  it.each(['audio', 'segments'] as const)('%s 提交失败回滚 SQL 并清理新文件', async failure => {
    const { generator, audioStore } = await createFixture();
    if (failure === 'audio') {
      vi.spyOn(SpeechOutputsRepo.prototype, 'completeAudio').mockImplementationOnce(() => { throw new Error('SQL failed'); });
    } else {
      vi.spyOn(SpeechSegmentsRepo.prototype, 'insertForAudio').mockImplementationOnce(() => { throw new Error('SQL failed'); });
    }
    const result = await generator.generateTurnAudio(input, '内容。');
    expect(result.status).toBe('failed');
    expect(audioStore.outputs.findByAudioId(result.audioId)).toBeNull();
    expect(audioStore.segments.getSegments(result.audioId)).toEqual([]);
  });

  it('删除开始即拒绝播放, 同 ID 请求等待同一次删除, 完成后段表一起消失', async () => {
    const { generator, audioStore, savedStatusesAtNotification } = await createFixture();
    const result = await generator.generateTurnAudio(input, '删除的内容。');
    const audioRecord = audioStore.outputs.findByAudioId(result.audioId)!;
    let acknowledgeDeletion!: () => void;
    const deleting = new Promise<void>(resolve => { acknowledgeDeletion = resolve; });
    let allowDeletion!: () => void;
    const allowed = new Promise<void>(resolve => { allowDeletion = resolve; });
    const deleteFile = audioStore.files.deleteFile.bind(audioStore.files);
    vi.spyOn(audioStore.files, 'deleteFile').mockImplementationOnce(async storagePath => {
      acknowledgeDeletion();
      await allowed;
      await deleteFile(storagePath);
    });
    const deletion = audioStore.deleteAudio(result.audioId);
    expect(audioStore.deleteAudio(result.audioId)).toBe(deletion);
    await deleting;
    try {
      expect(audioStore.outputs.findByAudioId(result.audioId)?.audioStatus).toBe('deleting');
      expect(await audioStore.openRead(result.audioId, new AbortController().signal)).toBeNull();
    } finally {
      allowDeletion();
    }
    await deletion;
    expect(fs.existsSync(audioRecord.storagePath)).toBe(false);
    expect(audioStore.outputs.findByAudioId(result.audioId)).toBeNull();
    expect(audioStore.segments.getSegments(result.audioId)).toEqual([]);
    expect(savedStatusesAtNotification.slice(-2)).toEqual(['deleting', undefined]);
  });

  it('删除正在读取的音频会先关闭读取, 再清理文件和记录', async () => {
    const { generator, audioStore } = await createFixture();
    const result = await generator.generateTurnAudio(input, '内容。');
    const audioRead = (await audioStore.openRead(result.audioId, new AbortController().signal))!;
    const closed = finished(audioRead.stream).catch(() => undefined);
    await audioStore.deleteAudio(result.audioId);
    await closed;
    expect(audioRead.stream.destroyed).toBe(true);
    expect(audioStore.outputs.findByAudioId(result.audioId)).toBeNull();
  });

  it.each(['file', 'record'] as const)('%s 删除失败保留 failed 记录, 再次删除可完成清理', async failure => {
    const { generator, audioStore } = await createFixture();
    const result = await generator.generateTurnAudio(input, '内容。');
    if (failure === 'file') vi.spyOn(audioStore.files, 'deleteFile').mockRejectedValueOnce(new Error('file is busy'));
    else vi.spyOn(SpeechOutputsRepo.prototype, 'deleteAudio').mockImplementationOnce(() => { throw new Error('SQL failed'); });
    await expect(audioStore.deleteAudio(result.audioId)).rejects.toThrow();
    expect(audioStore.outputs.findByAudioId(result.audioId)?.audioStatus).toBe('failed');
    expect(audioStore.getAudioPlayback(result.audioId)).toBeNull();
    await audioStore.deleteAudio(result.audioId);
    expect(audioStore.outputs.findByAudioId(result.audioId)).toBeNull();
  });

  it('启动只标记中断记录, 不删除文件或重新执行 TTS', async () => {
    const { generator, audioStore } = await createFixture();
    const ready = await generator.generateTurnAudio(input, '已完成。');
    const readyFile = audioStore.outputs.findByAudioId(ready.audioId)!.storagePath;
    audioStore.createAudioRecord({ audioId: 'interrupted', sessionId: input.sessionId, turnId: input.turnId, characterName: input.characterName });
    audioStore.createAudioRecord({ audioId: 'deletion', sessionId: input.sessionId, turnId: input.turnId, characterName: input.characterName });
    audioStore.outputs.updateAudioStatus('deletion', 'deleting', null);
    audioStore.markInterruptedAudioRecordsFailed();
    expect(audioStore.outputs.findByAudioId('interrupted')?.audioStatus).toBe('failed');
    expect(audioStore.outputs.findByAudioId('deletion')?.failureMessage).toContain('删除');
    expect(audioStore.outputs.findByAudioId(ready.audioId)?.audioStatus).toBe('ready');
    expect(fs.existsSync(readyFile)).toBe(true);
    expect(provider.synthesize).toHaveBeenCalledTimes(1);
  });

  it('磁盘等待期间记录已被 Session 删除时不广播不存在的 failed 状态', async () => {
    const { generator, audioStore, database, events } = await createFixture();
    const generationResult = await generator.generateTurnAudio(input, '内容。');
    vi.spyOn(audioStore.files, 'deleteFile').mockImplementationOnce(async () => {
      database.sqlite.prepare('DELETE FROM sessions WHERE id = ?').run(input.sessionId);
      throw new Error('file is busy');
    });
    await expect(audioStore.deleteAudio(generationResult.audioId)).rejects.toThrow('file is busy');
    expect(events.filter(event => event.type === 'session_audio_changed').at(-1))
      .toMatchObject({ audioStatus: 'deleting' });
  });
});

