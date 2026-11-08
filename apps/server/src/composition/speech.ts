import { randomUUID } from 'node:crypto';
import { statSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { dataResourceDir } from '@ema-agent/storage/dataPaths';
import type { Database } from '@ema-agent/storage';
import type { Character, CharacterStore } from '@ema-agent/characters';
import { ProviderError, type ModelBindings, type Providers } from '@ema-agent/providers';
import {
  AudioStore,
  SpeechGenerator,
  SpeechRequestError,
  SpeechVoicePreviewError,
  type SpeechGenerateEvent,
  type AudioRecordEvent,
  type StartTurnSpeechInput,
  type SpeechVoicePreviewResult,
} from '@ema-agent/speech';
import { createSTTCall, STTError, type TranscriptionRequest, type TranscriptionResult } from '@ema-agent/stt';
import { createTTSCall, TTSError, type TTSConnection, type TTSVoiceReference } from '@ema-agent/tts';
import type { UsageRecorder } from '@ema-agent/usage';
import type { Turn } from '@ema-agent/turn';

export interface SpeechSocketClient {
  sendControl(event: SpeechGenerateEvent): void;
  close(): void;
}

export interface SpeechGenerationChoice {
  readonly characterName: string;
  /** null 表示可以生成; 非空时由 UI 显示具体不可用原因. */
  readonly unavailableReason: string | null;
}

export interface SpeechComposition {
  readonly speechGenerator: SpeechGenerator;
  readonly audioStore: AudioStore;
  createTurnSpeechInput(
    sessionId: string,
    turnId: string,
    characterName?: string,
    signal?: AbortSignal,
  ): StartTurnSpeechInput;
  turnAudioRecords(turn: Turn, text: string): {
    records: ReturnType<AudioStore['listAudioSummaries']>;
    currentCharacter: SpeechGenerationChoice;
    generationChoices: SpeechGenerationChoice[];
  };
  previewVoice(
    providerId: string,
    modelId: string,
    text: string,
    signal?: AbortSignal,
  ): Promise<SpeechVoicePreviewResult>;
  transcribe(request: TranscriptionRequest): Promise<TranscriptionResult | undefined>;
  sttPreview(providerId: string, modelId: string, signal?: AbortSignal): Promise<{ text: string; referenceText: string }>;
  attachSpeechSocket(sessionId: string, turnId: string, client: SpeechSocketClient): void;
  detachSpeechSocket(sessionId: string, turnId: string, client: SpeechSocketClient): void;
}

export function openSpeech(
  dataDb: Database,
  activeDataDir: string,
  usageRecorder: UsageRecorder,
  providers: Providers,
  modelBindings: ModelBindings,
  characters: CharacterStore,
  emitArchiveChanged: (event: AudioRecordEvent) => void,
): SpeechComposition {
  const audioStore = new AudioStore(dataDb, dataResourceDir(activeDataDir, 'audio'), emitArchiveChanged);
  // 每个 Turn 保留当前状态订阅, 断开或发送结束事件后移除. 生成本身由 SpeechGenerator 登记.
  const speechClientsByTurnId = new Map<string, SpeechSocketClient>();
  const speechGenerator = new SpeechGenerator(audioStore, usageRecorder, event => {
    const client = speechClientsByTurnId.get(event.turnId);
    if (!client) return;
    const terminal = event.type === 'speech_generate_completed'
      || event.type === 'speech_generate_cancelled' || event.type === 'speech_generate_failed';
    try {
      client.sendControl(event);
    } finally {
      if (terminal) {
        speechClientsByTurnId.delete(event.turnId);
        client.close();
      }
    }
  });

  const requireCharacterVoice = (character: Character): TTSVoiceReference => {
    const reference = character.voiceSamples.find(sample => sample.isPrimary);
    if (!reference) {
      throw new SpeechRequestError('speech/primary_voice_missing', '角色没有选用主参考音频');
    }
    const audioPath = characters.voiceSamples.resolveFile(character.name, reference.name);
    if (!statSync(audioPath, { throwIfNoEntry: false })?.isFile()) {
      throw new SpeechRequestError('speech/voice_file_missing', '角色的参考音频文件找不到或无法读取');
    }
    return {
      kind: 'reference',
      resourceName: reference.name,
      resourceUpdatedAt: reference.updatedAt,
      registrationName: 'ema-' + randomUUID(),
      audioPath,
      promptText: reference.promptText,
      promptLanguage: reference.promptLang,
    };
  };

  const requireTTS = () => {
    const binding = modelBindings.get('tts');
    if (!binding) throw new SpeechRequestError('speech/tts_unbound', '尚未绑定 TTS 模型');
    try {
      const connection = providers.resolveConnection(binding.providerId, 'tts');
      // 检查本地协议/模型选择, 不发送模型请求.
      createTTSCall(connection, binding.modelId);
      return { ...binding, connection };
    } catch (error) {
      if (error instanceof ProviderError || error instanceof TTSError) {
        throw new SpeechRequestError('speech/tts_unavailable', error.message);
      }
      throw error;
    }
  };

  const createTurnSpeechInput: SpeechComposition['createTurnSpeechInput'] = (sessionId, turnId, characterName, signal) => {
    const character = characterName === undefined ? characters.current() : characters.get(characterName);
    if (!character) throw new SpeechRequestError('speech/character_not_found', '角色已不存在');
    const tts = requireTTS();
    return {
      sessionId,
      turnId,
      characterName: character.name,
      voiceReference: requireCharacterVoice(character),
      providerId: tts.providerId,
      modelId: tts.modelId,
      connection: tts.connection,
      ...(signal ? { signal } : {}),
    };
  };

  const transcribe: SpeechComposition['transcribe'] = async request => {
    const binding = modelBindings.get('stt');
    if (!binding) return undefined;
    const callSTT = createSTTCall(
      providers.resolveConnection(binding.providerId, 'stt'),
      binding.modelId,
    );
    const startedAt = Date.now();
    const callId = randomUUID();
    const result = await callSTT(request).catch(error => {
      const cancelled = request.signal?.aborted === true || (error instanceof Error && error.name === 'AbortError');
      let errorCode = 'stt/call_failed';
      if (cancelled) errorCode = 'stt/aborted';
      else if (error instanceof STTError) errorCode = error.code;
      recordSTTUsage(usageRecorder, callId, binding.providerId, binding.modelId, startedAt,
        cancelled ? 'cancelled' : 'failed', null, errorCode);
      throw error;
    });
    const lastEndMs = result.segments?.reduce((max, s) => Math.max(max, s.endMs), 0) ?? 0;
    recordSTTUsage(usageRecorder, callId, binding.providerId, binding.modelId, startedAt, 'completed',
      lastEndMs > 0 ? lastEndMs / 1000 : null, null);
    return result;
  };

  const sttPreview: SpeechComposition['sttPreview'] = async (providerId, modelId, signal) => {
    const connection = providers.resolveConnection(providerId, 'stt');
    const character = characters.current();
    const sample = character.voiceSamples.find(value => value.isPrimary);
    if (!sample) {
      throw new ProviderError('invalid_configuration', '当前角色未配置参考音频,请先在角色卡添加');
    }
    const audioPath = characters.voiceSamples.resolveFile(character.name, sample.name);
    const audio = await readFile(audioPath);
    const callSTT = createSTTCall(connection, modelId);
    const startedAt = Date.now();
    const callId = randomUUID();
    const result = await callSTT({
      audio: new Uint8Array(audio),
      mimeType: sample.mimeType,
      ...(signal ? { signal } : {}),
    }).catch(error => {
      const cancelled = signal?.aborted === true || (error instanceof Error && error.name === 'AbortError');
      let errorCode = 'stt/call_failed';
      if (cancelled) errorCode = 'stt/aborted';
      else if (error instanceof STTError) errorCode = error.code;
      recordSTTUsage(usageRecorder, callId, providerId, modelId, startedAt,
        cancelled ? 'cancelled' : 'failed', null, errorCode);
      throw error;
    });
    const lastEndMs = result.segments?.reduce((max, segment) => Math.max(max, segment.endMs), 0) ?? 0;
    recordSTTUsage(usageRecorder, callId, providerId, modelId, startedAt, 'completed',
      lastEndMs > 0 ? lastEndMs / 1000 : null, null);
    return { text: result.text, referenceText: sample.promptText };
  };

  return {
    speechGenerator,
    audioStore,
    createTurnSpeechInput,
    transcribe,
    sttPreview,
    turnAudioRecords(turn, text) {
      let commonReason: string | null = null;
      if (turn.status !== 'completed') commonReason = '只能为已完成的回复生成完整语音';
      else if (!text.trim()) commonReason = '该轮没有可朗读的正文';
      else {
        try {
          requireTTS();
        } catch (error) {
          commonReason = error instanceof Error ? error.message : String(error);
        }
      }
      const choice = (character: Character): SpeechGenerationChoice => {
        let unavailableReason = commonReason;
        if (!unavailableReason) {
          try {
            requireCharacterVoice(character);
          } catch (error) {
            unavailableReason = error instanceof Error ? error.message : String(error);
          }
        }
        return { characterName: character.name, unavailableReason };
      };
      return {
        records: audioStore.listAudioSummaries(turn.id),
        currentCharacter: choice(characters.current()),
        generationChoices: characters.list()
          .filter(character => character.voiceSamples.some(sample => sample.isPrimary))
          .map(choice),
      };
    },
    async previewVoice(providerId, modelId, text, signal) {
      const character = characters.current();
      let voiceReference: TTSVoiceReference;
      try {
        voiceReference = requireCharacterVoice(character);
      } catch (error) {
        throw new SpeechVoicePreviewError('no_reference_audio', error instanceof Error ? error.message : String(error), error);
      }
      let connection: TTSConnection;
      try {
        connection = providers.resolveConnection(providerId, 'tts');
        createTTSCall(connection, modelId);
      } catch (error) {
        // 本地配置不可用时返回 400, 不把尚未发送的请求报告成供应商合成失败.
        throw new SpeechVoicePreviewError('client_unavailable', error instanceof Error ? error.message : String(error), error);
      }
      return speechGenerator.previewVoice({
        providerId,
        modelId,
        characterName: character.name,
        voiceReference,
        connection,
        text,
        ...(signal ? { signal } : {}),
      });
    },
    attachSpeechSocket(sessionId, turnId, client) {
      speechClientsByTurnId.get(turnId)?.close();
      speechClientsByTurnId.set(turnId, client);
      const speechGeneration = speechGenerator.findTurnGeneration(turnId);
      if (speechGeneration) {
        const info = speechGenerator.getAudioPlayback(speechGeneration.audioId)!;
        client.sendControl({ type: 'speech_segments', ...info });
        return;
      }
      const saved = audioStore.outputs.findLatestReadyAudio(turnId, characters.current().name);
      if (saved) {
        client.sendControl({ type: 'speech_segments', ...speechGenerator.getAudioPlayback(saved.audioId)! });
        client.sendControl({
          type: 'speech_generate_completed',
          audioId: saved.audioId,
          characterName: saved.characterName,
          sessionId,
          turnId,
          audioAvailable: true,
        });
      } else {
        client.sendControl({ type: 'speech_generate_unavailable', sessionId, turnId });
      }
      speechClientsByTurnId.delete(turnId);
      client.close();
    },
    detachSpeechSocket(_sessionId, turnId, client) {
      if (speechClientsByTurnId.get(turnId) === client) speechClientsByTurnId.delete(turnId);
    },
  };
}

function recordSTTUsage(
  recorder: UsageRecorder,
  id: string,
  providerId: string,
  modelId: string,
  startedAt: number,
  status: 'completed' | 'failed' | 'cancelled',
  seconds: number | null,
  errorCode: string | null,
): void {
  recorder.record({
    id,
    sessionId: null,
    turnId: null,
    capability: 'stt',
    providerId,
    modelId,
    status,
    inputTokens: null,
    outputTokens: null,
    cacheReadInputTokens: null,
    cacheWriteInputTokens: null,
    quantity: seconds,
    unit: seconds === null ? null : 'second',
    durationMs: Date.now() - startedAt,
    errorCode,
    createdAt: startedAt,
  });
}
