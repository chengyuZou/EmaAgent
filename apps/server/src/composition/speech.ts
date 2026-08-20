// 语音一族：TTS 绑定解析、角色声音准备、Turn 级语音输出、试听与 Session 音频归档。
import path from 'node:path';
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
  prepareSpeechVoice,
  type AudioArchive,
  type SpeechEvent,
} from '@ema-agent/speech';
import {
  SessionStatsRepo,
  type Database,
} from '@ema-agent/storage';
import { createSpeechToText, type TranscriptionRequest, type TranscriptionResult } from '@ema-agent/stt';
import { createTextToSpeech, type TtsVoiceReference } from '@ema-agent/tts';
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
  const sessionStats = new SessionStatsRepo(dataDb.sqlite);

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

  const resolveTextToSpeech = (providerId: string) => {
    try {
      return createTextToSpeech(providers.resolveConnection(providerId, 'tts'));
    } catch {
      return undefined;
    }
  };

  const voicePreview = new SpeechVoicePreview(
    resolveTextToSpeech,
    {
      current: () => {
        const character = characters.current();
        const voice = resolveCharacterVoice(character);
        // Speech 当前以 cardId 命名缓存键，但其值语义就是角色 ID。
        return voice ? { cardId: character.id, voice } : null;
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

    let textToSpeech;
    try {
      textToSpeech = createTextToSpeech(providers.resolveConnection(binding.providerId, 'tts'));
    } catch (err) {
      if (err instanceof ProviderError) return null;
      throw err;
    }

    const voice = await prepareSpeechVoice(
      reference,
      textToSpeech,
      binding.modelId,
      character.id,
      binding.providerId,
      voiceCache,
      setup.signal,
    );

    const coordinator = new SpeechCoordinator({
      sessionId: setup.sessionId,
      turnId: setup.turnId,
      providerId: binding.providerId,
      model: binding.modelId,
      voice,
      textToSpeech,
      emit: setup.emit,
      archive: audioArchive,
      format: 'mp3',
      signal: setup.signal,
      usageRecorder,
    });

    return {
      acceptTextDelta: delta => coordinator.acceptTextDelta(delta),
      finish: async () => {
        const { audio } = await coordinator.finish();
        // 最终音频的持久统计是可重建投影，失败只损失统计，不影响 Turn。
        if (audio) {
          sessionStats.recordAudioMerged({
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
      },
      abort: () => coordinator.abort(),
    };
  };

  const transcribe: SpeechComposition['transcribe'] = async request => {
    const binding = modelBindings.get('stt');
    if (!binding) return undefined;
    const stt = createSpeechToText(providers.resolveConnection(binding.providerId, 'stt'));
    const startedAt = Date.now();
    const result = await stt.transcribe({ ...request, model: binding.modelId });
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

  return { audioArchive, voiceCache, usageRecorder, voicePreview, transcribe, startTurnSpeech };
}
