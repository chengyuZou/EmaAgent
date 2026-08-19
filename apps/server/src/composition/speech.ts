// 语音一族：TTS 绑定解析、角色声音准备、Turn 级语音输出与 Session 音频归档。
import path from 'node:path';
import type { CharacterCardStore } from '@ema-agent/characters';
import {
  ProviderError,
  type ModelBindings,
  type Providers,
} from '@ema-agent/providers';
import {
  FsAudioArchive,
  SpeechCoordinator,
  SpeechVoiceCache,
  prepareSpeechVoice,
  type AudioArchive,
  type SpeechEvent,
} from '@ema-agent/speech';
import {
  SessionStatsRepo,
  UsageRecordsRepo,
  type Database,
} from '@ema-agent/storage';
import { createTextToSpeech } from '@ema-agent/tts';
import type { UsageRecorder } from '@ema-agent/usage';

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
  providers: Providers,
  modelBindings: ModelBindings,
  cards: CharacterCardStore,
): SpeechComposition {
  const audioArchive = new FsAudioArchive(path.join(activeDataDir, 'sessions'));
  const voiceCache = new SpeechVoiceCache();
  const usageRecorder = new UsageRecordsRepo(dataDb.sqlite);
  const sessionStats = new SessionStatsRepo(dataDb.sqlite);

  const startTurnSpeech: SpeechComposition['startTurnSpeech'] = async setup => {
    const binding = modelBindings.get('tts');
    if (!binding) return null;

    const card = cards.current();
    // 候选顺序：enabled + isPrimary 优先，其次任一 enabled（与旧 resolveVoice 一致）。
    const reference = card.voiceReferences.find(v => v.enabled && v.isPrimary)
      ?? card.voiceReferences.find(v => v.enabled);
    if (!reference) return null;

    let refAudioPath: string;
    try {
      refAudioPath = cards.resolveVoiceReferenceFile(card.id, reference.id);
    } catch {
      // 参考音频损坏只降级声音能力，不阻断文字对话。
      return null;
    }

    let textToSpeech;
    try {
      textToSpeech = createTextToSpeech(providers.resolveConnection(binding.providerId, 'tts'));
    } catch (err) {
      if (err instanceof ProviderError) return null;
      throw err;
    }

    const voice = await prepareSpeechVoice(
      { kind: 'reference', audioPath: refAudioPath, promptText: reference.promptText, promptLanguage: reference.promptLang },
      textToSpeech,
      binding.modelId,
      card.id,
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
      usageRecorder: usageRecorder,
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

  return { audioArchive, voiceCache, usageRecorder, startTurnSpeech };
}
