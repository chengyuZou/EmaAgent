// 语音一族：TTS 绑定解析、角色声音准备、Turn 级语音输出、试听与 Session 音频归档。
import path from 'node:path';
import { readFile } from 'node:fs/promises';
import type { Character, CharacterStore } from '@ema-agent/characters';
import {
  ProviderError,
  type ModelBindings,
  type Providers,
} from '@ema-agent/providers';
import {
  FsAudioArchive,
  SpeechCoordinator,
  SpeechVoiceCache,
  SpeechVoicePreview,
  type AudioArchive,
  type SpeechControlEvent,
  type SpeechStreamEvent,
  type SpeechVoicePreviewTts,
  type SpeechArchiveEvent,
} from '@ema-agent/speech';
import {
  SpeechOutputsRepo,
  type Database,
} from '@ema-agent/storage';
import { createSttCall, type TranscriptionRequest, type TranscriptionResult } from '@ema-agent/stt';
import {
  createTtsCall,
  createTtsVoiceRegistrar,
  TtsError,
  type TtsVoiceReference,
} from '@ema-agent/tts';
import { createUsageRecord, reportUsage, type UsageRecorder } from '@ema-agent/usage';

/** 单 Turn 的语音输出句柄；由 turnFanout 喂文本增量并收口。 */
export interface TurnSpeechHandle {
  acceptTextDelta(delta: string): void;
  finish(): Promise<void>;
  abort(): Promise<void>;
}

export interface SpeechSocketClient {
  sendControl(event: SpeechControlEvent): void;
  sendAudio(bytes: Uint8Array): void;
  close(): void;
}

export interface SpeechComposition {
  readonly audioArchive: AudioArchive;
  readonly voiceCache: SpeechVoiceCache;
  readonly usageRecorder: UsageRecorder;
  /** TTS 试听（设置页）；角色无参考音频或 Provider 不可用时报领域错误。 */
  readonly voicePreview: SpeechVoicePreview;
  /**
   * 语音输入转写：STT 未绑定返回 undefined（route 如实 503）；
   * 成功调用按音频时长（segments 最大 endMs）记一条 usage。
   */
  readonly transcribe: (
    request: Omit<TranscriptionRequest, 'model'>,
  ) => Promise<TranscriptionResult | undefined>;
  /** STT 试听（设置页）：用当前角色主参考音频到指定 Provider 模型转写，返回转写文本与参考文本。 */
  readonly sttPreview: (
    providerId: string,
    modelId: string,
    signal?: AbortSignal,
  ) => Promise<{ text: string; referenceText: string }>;
  /**
   * 为一个根 Turn 启动语音输出；无 TTS 绑定、角色无参考音频或 Provider 不可用
   * 都返回 null（语音是可选输出增强，不改变 Turn 终态）。
   */
  startTurnSpeech(setup: {
    sessionId: string;
    turnId: string;
    signal: AbortSignal;
  }): Promise<TurnSpeechHandle | null>;
  attachSpeechSocket(turnId: string, client: SpeechSocketClient): boolean;
  /** 返回 true 表示客户端请求取消当前语音。 */
  handleSpeechSocketMessage(turnId: string, message: string): boolean;
  detachSpeechSocket(turnId: string, client: SpeechSocketClient): void;
}

export function openSpeech(
  dataDb: Database,
  activeDataDir: string,
  usageRecorder: UsageRecorder,
  providers: Providers,
  modelBindings: ModelBindings,
  characters: CharacterStore,
  emitArchiveChanged: (event: SpeechArchiveEvent) => void,
): SpeechComposition {
  const audioArchive = new FsAudioArchive(path.join(activeDataDir, 'sessions'));
  const voiceCache = new SpeechVoiceCache();
  const speechOutputs = new SpeechOutputsRepo(dataDb.sqlite);
  const channels = new Map<string, TurnSpeechChannel>();

  /** 参考音频只有显式主资源才参与 TTS；没有主资源即关闭当前角色语音。 */
  const resolveCharacterVoice = (character: Character): TtsVoiceReference | null => {
    const reference = character.voiceSamples.find(value => value.isPrimary);
    if (!reference) return null;
    try {
      return {
        kind: 'reference',
        resourceName: reference.name,
        resourceUpdatedAt: reference.updatedAt,
        registrationName: `${character.name}-${path.parse(reference.name).name}`,
        audioPath: characters.resolveVoiceSampleFile(character.name, reference.name),
        promptText: reference.promptText,
        promptLanguage: reference.promptLang,
      };
    } catch {
      // 参考音频损坏只降级声音能力，不阻断文字对话。
      return null;
    }
  };

  /** 按 providerId + modelId 即时冻结一对 TTS 入口；连接不可用或未启用返回 undefined。 */
  const resolveTts = (providerId: string, modelId: string): SpeechVoicePreviewTts | undefined => {
    try {
      const connection = providers.resolveConnection(providerId, 'tts');
      return {
        ttsVoiceRegistrar: createTtsVoiceRegistrar(connection, modelId),
        callTts: createTtsCall(connection, modelId),
      };
    } catch {
      return undefined;
    }
  };

  const voicePreview = new SpeechVoicePreview(
    resolveTts,
    {
      current: () => {
        const character = characters.current();
        const voice = resolveCharacterVoice(character);
        return voice ? { characterName: character.name, voice } : null;
      },
    },
    voiceCache,
    usageRecorder,
  );

  const startTurnSpeech: SpeechComposition['startTurnSpeech'] = async setup => {
    const binding = modelBindings.get('tts');
    if (!binding) return null;

    const character = characters.current();
    const reference = resolveCharacterVoice(character);
    if (!reference) return null;

    let callTts;
    let ttsVoiceRegistrar;
    try {
      const connection = providers.resolveConnection(binding.providerId, 'tts');
      ttsVoiceRegistrar = createTtsVoiceRegistrar(connection, binding.modelId);
      callTts = createTtsCall(connection, binding.modelId);
    } catch (err) {
      // 连接未启用（ProviderError）或 DashScope 模型族无法识别（TtsError）都降级为无语音。
      if (err instanceof ProviderError || err instanceof TtsError) return null;
      throw err;
    }

    const channel = new TurnSpeechChannel();
    channels.set(setup.turnId, channel);
    const speechAbort = new AbortController();
    const signal = AbortSignal.any([setup.signal, speechAbort.signal]);
    channel.onCancel = () => speechAbort.abort('speech socket disconnected');

    let voice;
    try {
      voice = await voiceCache.prepare({
        reference,
        ttsVoiceRegistrar,
        characterName: character.name,
        providerId: binding.providerId,
        modelId: binding.modelId,
        signal,
      });
    } catch (error) {
      channels.delete(setup.turnId);
      channel.cancel();
      throw error;
    }
    try {
      await channel.waitForClient(signal);
    } catch (error) {
      channels.delete(setup.turnId);
      channel.cancel();
      throw error;
    }

    const coordinator = new SpeechCoordinator({
      sessionId: setup.sessionId,
      turnId: setup.turnId,
      providerId: binding.providerId,
      modelId: binding.modelId,
      voice,
      callTts,
      emit: event => channel.emit(event),
      archive: audioArchive,
      waitForPlaybackSlot: () => channel.waitForPlaybackSlot(),
      signal,
      usageRecorder,
    });
    channel.onCancel = () => { void coordinator.abort(); };

    return {
      acceptTextDelta: delta => coordinator.acceptTextDelta(delta),
      finish: async () => {
        const { audio } = await coordinator.finish();
        // 最终音频的持久统计是可重建投影，失败只损失统计，不影响 Turn。
        if (audio) {
          speechOutputs.record({
            turnId: setup.turnId,
            sessionId: setup.sessionId,
            storagePath: audio.path,
            mimeType: audio.mime,
            byteSize: audio.byteSize,
            durationMs: audio.durationMs,
            segmentCount: audio.segmentCount,
            createdAt: Date.now(),
          });
          emitArchiveChanged({
            type: 'session_audio_changed',
            sessionId: setup.sessionId,
            turnId: setup.turnId,
          });
        }
        channels.delete(setup.turnId);
        channel.close();
      },
      abort: async () => {
        await coordinator.abort();
        channels.delete(setup.turnId);
        channel.close();
      },
    };
  };

  const transcribe: SpeechComposition['transcribe'] = async request => {
    const binding = modelBindings.get('stt');
    if (!binding) return undefined;
    const callStt = createSttCall(
      providers.resolveConnection(binding.providerId, 'stt'),
      binding.modelId,
    );
    const startedAt = Date.now();
    const result = await callStt(request);
    const lastEndMs = result.segments?.reduce((max, s) => Math.max(max, s.endMs), 0) ?? 0;
    reportUsage(usageRecorder, createUsageRecord({
      capability: 'stt',
      providerId: binding.providerId,
      modelId: binding.modelId,
      status: 'completed',
      startedAt,
      durationMs: Date.now() - startedAt,
      quantity: lastEndMs > 0 ? lastEndMs / 1000 : null,
      unit: lastEndMs > 0 ? 'second' : null,
    }), error => console.warn('[usage] STT 记账失败:', error));
    return result;
  };

  /** STT 试听：当前角色主参考音频 → 指定 Provider 模型转写；无参考音频抛 no_reference_audio。 */
  const sttPreview: SpeechComposition['sttPreview'] = async (providerId, modelId, signal) => {
    const connection = providers.resolveConnection(providerId, 'stt');
    const character = characters.current();
    const sample = character.voiceSamples.find(value => value.isPrimary);
    if (!sample) {
      throw new ProviderError('invalid_configuration', '当前角色未配置参考音频，请先在角色卡添加');
    }
    const audioPath = characters.resolveVoiceSampleFile(character.name, sample.name);
    const audio = await readFile(audioPath);
    const callStt = createSttCall(connection, modelId);
    const result = await callStt({
      audio: new Uint8Array(audio),
      mimeType: sample.mimeType,
      ...(signal ? { signal } : {}),
    });
    return { text: result.text, referenceText: sample.promptText };
  };

  return {
    audioArchive,
    voiceCache,
    usageRecorder,
    voicePreview,
    transcribe,
    sttPreview,
    startTurnSpeech,
    attachSpeechSocket(turnId, client) {
      const channel = channels.get(turnId);
      if (!channel) return false;
      channel.attach(client);
      return true;
    },
    detachSpeechSocket(turnId, client) {
      channels.get(turnId)?.detach(client);
    },
    handleSpeechSocketMessage(turnId, message) {
      const parsed = parseSpeechClientMessage(message);
      if (parsed?.type === 'sentence_played') {
        channels.get(turnId)?.sentencePlayed(parsed.sentenceId);
        return false;
      }
      return parsed?.type === 'cancel';
    },
  };
}

/** 每个 Turn 一条实时语音连接，同时用已完成句子的确认数量限制生成领先量。 */
class TurnSpeechChannel {
  private client: SpeechSocketClient | null = null;
  private connected: (() => void) | null = null;
  private readonly completedSentenceIds: string[] = [];
  private playbackSlot: (() => void) | null = null;
  onCancel: () => void = () => {};

  attach(client: SpeechSocketClient): void {
    this.client?.close();
    this.client = client;
    this.connected?.();
    this.connected = null;
  }

  detach(client: SpeechSocketClient): void {
    if (this.client !== client) return;
    this.client = null;
    this.releasePlaybackSlot();
    this.onCancel();
  }

  emit(event: SpeechStreamEvent): void {
    if (!this.client) return;
    if (event.type === 'sentence_completed') {
      this.completedSentenceIds.push(event.sentenceId);
    }
    this.send(event);
  }

  waitForPlaybackSlot(): Promise<void> {
    if (this.completedSentenceIds.length < 3) return Promise.resolve();
    return new Promise(resolve => { this.playbackSlot = resolve; });
  }

  sentencePlayed(sentenceId: string): void {
    if (this.completedSentenceIds[0] !== sentenceId) return;
    this.completedSentenceIds.shift();
    if (this.completedSentenceIds.length < 3 && this.playbackSlot) {
      const resolve = this.playbackSlot;
      this.playbackSlot = null;
      resolve();
    }
  }

  waitForClient(signal: AbortSignal): Promise<void> {
    if (this.client) return Promise.resolve();
    if (signal.aborted) return Promise.reject(signal.reason ?? new Error('Speech cancelled'));
    return new Promise((resolve, reject) => {
      let settled = false;
      const finish = (error?: unknown): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        signal.removeEventListener('abort', abort);
        this.connected = null;
        if (error) reject(error);
        else resolve();
      };
      const timeout = setTimeout(() => finish(new Error('Speech WebSocket connection timed out')), 10_000);
      const abort = (): void => finish(signal.reason ?? new Error('Speech cancelled'));
      this.connected = () => finish();
      signal.addEventListener('abort', abort, { once: true });
    });
  }

  cancel(): void {
    this.onCancel();
    this.close();
  }

  close(): void {
    this.client?.close();
    this.client = null;
    this.releasePlaybackSlot();
  }

  private send(event: SpeechStreamEvent): void {
    if (!this.client) return;
    if (event.type === 'audio_chunk') this.client.sendAudio(event.bytes);
    else this.client.sendControl(event);
  }

  private releasePlaybackSlot(): void {
    if (!this.playbackSlot) return;
    const resolve = this.playbackSlot;
    this.playbackSlot = null;
    resolve();
  }
}

function parseSpeechClientMessage(message: string):
  | { type: 'sentence_played'; sentenceId: string }
  | { type: 'cancel' }
  | null {
  try {
    const value = JSON.parse(message) as { type?: unknown; sentenceId?: unknown };
    if (value.type === 'cancel') return { type: 'cancel' };
    if (value.type === 'sentence_played' && typeof value.sentenceId === 'string') {
      return { type: 'sentence_played', sentenceId: value.sentenceId };
    }
    return null;
  } catch {
    return null;
  }
}
