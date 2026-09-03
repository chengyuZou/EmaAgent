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
  SpeechSegmentLibrary,
  SpeechVoiceCache,
  SpeechVoicePreview,
  type AudioArchive,
  type SpeechEvent,
  type SpeechVoicePreviewTts,
} from '@ema-agent/speech';
import {
  SpeechOutputsRepo,
  SpeechSegmentsRepo,
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
    emit: (event: SpeechEvent) => void;
  }): Promise<TurnSpeechHandle | null>;
}

export function openSpeech(
  dataDb: Database,
  activeDataDir: string,
  usageRecorder: UsageRecorder,
  providers: Providers,
  modelBindings: ModelBindings,
  characters: CharacterStore,
): SpeechComposition {
  const audioArchive = new FsAudioArchive(path.join(activeDataDir, 'sessions'));
  const voiceCache = new SpeechVoiceCache();
  const speechOutputs = new SpeechOutputsRepo(dataDb.sqlite);
  const segmentLibrary = new SpeechSegmentLibrary(
    new SpeechSegmentsRepo(dataDb.sqlite),
    audioArchive,
  );
  segmentLibrary.enforceLimits();

  /** 候选顺序：enabled + isPrimary 优先，其次任一 enabled。 */
  const resolveCharacterVoice = (character: Character): TtsVoiceReference | null => {
    const reference = character.voiceSamples.find(value => value.enabled && value.isPrimary)
      ?? character.voiceSamples.find(value => value.enabled);
    if (!reference) return null;
    try {
      return {
        kind: 'reference',
        audioPath: characters.resolveVoiceSampleFile(character.id, reference.id),
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
        return voice ? { characterId: character.id, voice } : null;
      },
    },
    voiceCache,
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

    const voice = await voiceCache.prepare({
      reference,
      ttsVoiceRegistrar,
      characterId: character.id,
      providerId: binding.providerId,
      modelId: binding.modelId,
      signal: setup.signal,
    });

    const coordinator = new SpeechCoordinator({
      sessionId: setup.sessionId,
      turnId: setup.turnId,
      providerId: binding.providerId,
      modelId: binding.modelId,
      voice,
      callTts,
      emit: setup.emit,
      archive: audioArchive,
      format: 'mp3',
      signal: setup.signal,
      usageRecorder,
      onSegmentCompleted: segment => segmentLibrary.record(segment),
      onTurnSegmentsDiscarded: turnId => segmentLibrary.discardTurn(turnId),
    });

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
        }
        segmentLibrary.enforceLimits();
      },
      abort: () => coordinator.abort(),
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
    const sample = character.voiceSamples.find(value => value.enabled && value.isPrimary)
      ?? character.voiceSamples.find(value => value.enabled);
    if (!sample) {
      throw new ProviderError('invalid_configuration', '当前角色未配置参考音频，请先在角色卡添加');
    }
    const audioPath = characters.resolveVoiceSampleFile(character.id, sample.id);
    const audio = await readFile(audioPath);
    const callStt = createSttCall(connection, modelId);
    const result = await callStt({
      audio: new Uint8Array(audio),
      mimeType: sample.mimeType,
      ...(signal ? { signal } : {}),
    });
    return { text: result.text, referenceText: sample.promptText };
  };

  return { audioArchive, voiceCache, usageRecorder, voicePreview, transcribe, sttPreview, startTurnSpeech };
}
