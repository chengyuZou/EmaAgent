import { randomUUID } from 'node:crypto';
import { dataResourceDir } from '@ema-agent/storage/dataPaths';
import { statSync } from 'node:fs';
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
  type SpeechGenerateEvent,
  type SpeechGenerationResult,
  type SpeechVoicePreviewTTS,
  type SpeechArchiveEvent,
  type TurnSpeechGenerateResult,
} from '@ema-agent/speech';
import {
  SpeechOutputsRepo,
  type Database,
} from '@ema-agent/storage';
import { createSTTCall, STTError, type TranscriptionRequest, type TranscriptionResult } from '@ema-agent/stt';
import {
  createTTSCall,
  createTTSVoiceRegistrar,
  TTSError,
  type TTSVoiceReference,
} from '@ema-agent/tts';
import type { UsageRecorder } from '@ema-agent/usage';
import type { Turn } from '@ema-agent/turn';

export class TurnSpeechRequestError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
    this.name = 'TurnSpeechRequestError';
  }
}

/** TurnFanout 喂入文字增量; cancel 只停语音, 保留已生成的音频. */
export interface TurnSpeechHandle {
  acceptTextDelta(delta: string): void;
  finish(): Promise<void>;
  cancel(): Promise<void>;
}

export interface SpeechSocketClient {
  sendControl(event: SpeechGenerateEvent): void;
  close(): void;
}

export interface TurnAudioRecord {
  readonly characterName: string;
  readonly storagePath: string;
  readonly byteSize: number;
  readonly durationMs: number;
  readonly createdAt: number;
}

export interface SpeechGenerationChoice {
  readonly characterName: string;
  /** null 表示可以生成; 非空时直接向用户说明不能生成的原因. */
  readonly unavailableReason: string | null;
}

export interface TurnAudioRecords {
  readonly records: readonly TurnAudioRecord[];
  readonly currentCharacter: SpeechGenerationChoice;
  /** 只列出选用了主参考音频的角色, 不改变全局激活角色. */
  readonly generationChoices: readonly SpeechGenerationChoice[];
}

export interface SpeechComposition {
  readonly audioArchive: FsAudioArchive;
  /** TTS 试听, 角色无参考音频或 Provider 不可用时报领域错误 */
  readonly voicePreview: SpeechVoicePreview;
  /** 语音输入转写 */
  readonly transcribe: (
    request: Omit<TranscriptionRequest, 'model'>,
  ) => Promise<TranscriptionResult | undefined>;
  /** STT 试听, 用当前角色主参考音频到指定 Provider 模型转写, 返回转写文本与参考文本 */
  readonly sttPreview: (
    providerId: string,
    modelId: string,
    signal?: AbortSignal,
  ) => Promise<{ text: string; referenceText: string }>;
  /** 为一个 Turn 启动语音输出 */
  startTurnSpeech(setup: {
    readonly sessionId: string;
    readonly turnId: string;
    readonly signal: AbortSignal;
  }): Promise<TurnSpeechHandle | null>;
  /** 从已保存的完整正文生成, 不要求有播放器, 成功后替换正式音频. */
  generateTurnSpeech(turn: Turn, text: string, characterName?: string): Promise<TurnSpeechGenerateResult>;
  turnAudioRecords(turn: Turn, text: string): TurnAudioRecords;
  attachSpeechSocket(sessionId: string, turnId: string, client: SpeechSocketClient): Promise<void>;
  /** 只断开状态通知, 不取消语音生成. */
  detachSpeechSocket(sessionId: string, turnId: string, client: SpeechSocketClient): void;
  cancelTurnSpeech(turnId: string): Promise<void>;
  cancelSessionSpeech(sessionId: string): Promise<void>;
  close(): Promise<void>;
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
  const audioArchive = new FsAudioArchive(dataResourceDir(activeDataDir, 'audio'));
  const voiceCache = new SpeechVoiceCache();
  const speechOutputs = new SpeechOutputsRepo(dataDb.sqlite);
  const jobs = new Map<string, SpeechJob>();
  let closed = false;

  const resolveCharacterVoice = (character: Character): TTSVoiceReference | null => {
    const reference = character.voiceSamples.find(value => value.isPrimary);
    if (!reference) return null;
    try {
      return {
        kind: 'reference',
        resourceName: reference.name,
        resourceUpdatedAt: reference.updatedAt,
        // SiliconFlow customName 只允许短 ASCII 名称, 不能直接使用中文角色名或资源名.
        // 注册名不参与本地音色缓存身份; UUID 避免不同参考音频的远端名称冲突.
        registrationName: `ema-${randomUUID()}`,
        audioPath: characters.resolveVoiceSampleFile(character.name, reference.name),
        promptText: reference.promptText,
        promptLanguage: reference.promptLang,
      };
    } catch {
      // 参考音频损坏只降级声音能力,不阻断文字对话.
      return null;
    }
  };

  const resolveTTS = (providerId: string, modelId: string): SpeechVoicePreviewTTS | undefined => {
    try {
      const connection = providers.resolveConnection(providerId, 'tts');
      return {
        ttsVoiceRegistrar: createTTSVoiceRegistrar(connection, modelId),
        callTTS: createTTSCall(connection, modelId),
      };
    } catch {
      return undefined;
    }
  };

  const requireCharacterVoice = (character: Character): TTSVoiceReference => {
    if (character.voiceSamples.length === 0) {
      throw new TurnSpeechRequestError('speech/voice_samples_missing', `角色${character.name}没有参考音频`);
    }
    if (!character.voiceSamples.some(sample => sample.isPrimary)) {
      throw new TurnSpeechRequestError('speech/primary_voice_missing', `角色${character.name}没有选用主参考音频`);
    }
    const reference = resolveCharacterVoice(character);
    if (!reference || !statSync(reference.audioPath, { throwIfNoEntry: false })?.isFile()) {
      throw new TurnSpeechRequestError('speech/voice_file_missing', `角色${character.name}的参考音频文件找不到或无法读取`);
    }
    return reference;
  };

  const requireTTS = () => {
    const binding = modelBindings.get('tts');
    if (!binding) {
      throw new TurnSpeechRequestError('speech/tts_unbound', '尚未绑定 TTS 模型, 请先在设置中配置');
    }
    try {
      const connection = providers.resolveConnection(binding.providerId, 'tts');
      return {
        binding,
        ttsVoiceRegistrar: createTTSVoiceRegistrar(connection, binding.modelId),
        callTTS: createTTSCall(connection, binding.modelId),
      };
    } catch (error) {
      if (error instanceof ProviderError || error instanceof TTSError) {
        throw new TurnSpeechRequestError('speech/tts_unavailable', `当前 TTS 模型不可用: ${error.message}`);
      }
      throw error;
    }
  };

  const generationChoice = (turn: Turn, text: string, character: Character): SpeechGenerationChoice => {
    let unavailableReason: string | null = null;
    if (turn.status !== 'completed') {
      unavailableReason = '只能为已完成的回复生成完整语音';
    } else if (!text.trim()) {
      unavailableReason = '该轮没有可朗读的正文';
    } else {
      try {
        requireCharacterVoice(character);
        requireTTS();
      } catch (error) {
        if (!(error instanceof TurnSpeechRequestError)) throw error;
        unavailableReason = error.message;
      }
    }
    return { characterName: character.name, unavailableReason };
  };

  const voicePreview = new SpeechVoicePreview(
    resolveTTS,
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

  const completeJob = (job: SpeechJob): Promise<TurnSpeechGenerateResult> => {
    job.completion ??= (async () => {
      let result: SpeechGenerationResult;
      try {
        const coordinator = await job.preparing;
        result = await coordinator.finish();
      } catch (error) {
        if (job.signal.aborted) {
          result = { status: 'cancelled', audio: null };
        } else {
          result = {
            status: 'failed',
            audio: null,
            code: 'speech/prepare_failed',
            message: error instanceof Error ? error.message : String(error),
          };
        }
      }

      const audioAvailable = audioArchive.findFinalized(job.sessionId, job.turnId, job.characterName) !== null;
      let response: TurnSpeechGenerateResult;
      if (result.status === 'failed') {
        response = {
          sessionId: job.sessionId,
          turnId: job.turnId,
          status: 'failed',
          audioAvailable,
          code: result.code,
          message: result.message,
        };
      } else if (result.status === 'cancelled') {
        response = { sessionId: job.sessionId, turnId: job.turnId, status: 'cancelled', audioAvailable };
      } else if (result.audio) {
        response = { sessionId: job.sessionId, turnId: job.turnId, status: 'completed', audioAvailable: true };
      } else {
        response = {
          sessionId: job.sessionId,
          turnId: job.turnId,
          status: 'failed',
          audioAvailable,
          code: 'speech/no_audio',
          message: '该轮没有生成可用音频, 请确认正文中有可朗读的内容',
        };
      }
      try {
        if (result.audio) {
          // 先完成文件和 SQL 记录, 再通知 Chat / Storage 和当前播放连接.
          emitArchiveChanged({
            type: 'session_audio_changed',
            sessionId: job.sessionId,
            turnId: job.turnId,
          });
        }
        if (response.status === 'failed') {
          job.client?.sendControl({
            type: 'speech_generate_failed',
            sessionId: job.sessionId,
            turnId: job.turnId,
            audioAvailable,
            code: response.code,
            message: response.message,
          });
        } else {
          const type = response.status === 'cancelled'
            ? 'speech_generate_cancelled'
            : 'speech_generate_completed';
          job.client?.sendControl({ type, sessionId: job.sessionId, turnId: job.turnId, audioAvailable });
        }
      } catch (error) {
        console.warn(`[speech] Turn ${job.turnId} 语音通知失败:`, error);
      } finally {
        job.signal.removeEventListener('abort', job.onAbort);
        jobs.delete(job.turnId);
        job.client?.close();
        job.client = null;
      }
      return response;
    })();
    return job.completion;
  };

  const cancelJob = (job: SpeechJob): Promise<void> => {
    job.abortController.abort('speech cancelled');
    return completeJob(job).then(() => undefined);
  };

  const createJob = (
    setup: { readonly sessionId: string; readonly turnId: string; readonly signal: AbortSignal },
    character: Character,
    savePartialAudio: boolean,
  ): SpeechJob => {
    if (closed) throw new TurnSpeechRequestError('speech/closed', '语音服务已关闭');
    if (jobs.has(setup.turnId)) {
      throw new TurnSpeechRequestError('speech/already_generating', '该轮正在生成语音, 请等待完成或先取消生成');
    }
    const reference = requireCharacterVoice(character);
    const { binding, callTTS, ttsVoiceRegistrar } = requireTTS();

    const abortController = new AbortController();
    const signal = AbortSignal.any([setup.signal, abortController.signal]);
    let job: SpeechJob;
    const preparing = voiceCache.prepare({
      reference,
      ttsVoiceRegistrar,
      characterName: character.name,
      providerId: binding.providerId,
      modelId: binding.modelId,
      signal,
    }).then(voice => new SpeechCoordinator({
      sessionId: setup.sessionId,
      turnId: setup.turnId,
      providerId: binding.providerId,
      modelId: binding.modelId,
      voice,
      callTTS,
      openAudio: format => audioArchive.openTurn(setup.sessionId, setup.turnId, character.name, format),
      signal,
      usageRecorder,
      savePartialAudio,
      saveAudioRecord: audio => {
        speechOutputs.record({
          turnId: setup.turnId,
          sessionId: setup.sessionId,
          ...audio,
          createdAt: Date.now(),
        });
      },
      onAudioReady: () => {
        job.audioReady = true;
        job.client?.sendControl({
          type: 'speech_generate_started',
          sessionId: job.sessionId,
          turnId: job.turnId,
        });
      },
      onSentenceError: error => {
        job.client?.sendControl({
          type: 'speech_generate_warning',
          sessionId: job.sessionId,
          turnId: job.turnId,
          ...error,
        });
      },
    }));
    job = {
      sessionId: setup.sessionId,
      turnId: setup.turnId,
      characterName: character.name,
      abortController,
      signal,
      preparing,
      audioReady: false,
      client: null,
      completion: null,
      onAbort: () => {
        void completeJob(job);
      },
    };
    // 声音注册期间也登记任务, 删除 Session 或关闭应用时才能取消并等它结束.
    jobs.set(setup.turnId, job);
    signal.addEventListener('abort', job.onAbort, { once: true });
    if (signal.aborted) void completeJob(job);
    return job;
  };

  const startTurnSpeech: SpeechComposition['startTurnSpeech'] = async setup => {
    let job: SpeechJob;
    try {
      job = createJob(setup, characters.current(), true);
    } catch (error) {
      if (error instanceof TurnSpeechRequestError) return null;
      throw error;
    }
    try {
      const coordinator = await job.preparing;
      if (job.signal.aborted) {
        await completeJob(job);
        return null;
      }
      return {
        acceptTextDelta: delta => coordinator.acceptTextDelta(delta),
        finish: () => completeJob(job).then(() => undefined),
        cancel: () => cancelJob(job),
      };
    } catch {
      await completeJob(job);
      return null;
    }
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
    const audioPath = characters.resolveVoiceSampleFile(character.name, sample.name);
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
    audioArchive,
    voicePreview,
    transcribe,
    sttPreview,
    startTurnSpeech,
    turnAudioRecords(turn, text) {
      return {
        records: speechOutputs.listForTurn(turn.id).map(row => ({
          characterName: audioArchive.characterNameFor(turn.id, row.storage_path),
          storagePath: row.storage_path,
          byteSize: row.byte_size,
          durationMs: row.duration_ms,
          createdAt: row.created_at,
        })),
        currentCharacter: generationChoice(turn, text, characters.current()),
        generationChoices: characters.list()
          .filter(character => character.voiceSamples.some(sample => sample.isPrimary))
          .map(character => generationChoice(turn, text, character)),
      };
    },
    async generateTurnSpeech(turn, text, characterName) {
      const character = characterName === undefined ? characters.current() : characters.get(characterName);
      if (!character) {
        throw new TurnSpeechRequestError('speech/character_not_found', `角色"${characterName}"已不存在`);
      }
      const job = createJob({
        sessionId: turn.sessionId,
        turnId: turn.id,
        // 手动生成不绑定 HTTP 连接, 页面切换或请求断开不取消任务.
        signal: new AbortController().signal,
      }, character, false);
      try {
        const coordinator = await job.preparing;
        coordinator.acceptTextDelta(text);
      } catch {
        // completeJob 把准备失败转换为同一份最终结果.
      }
      return completeJob(job);
    },
    async attachSpeechSocket(sessionId, turnId, client) {
      const job = jobs.get(turnId);
      if (job) {
        job.client?.close();
        job.client = client;
        if (job.audioReady) {
          client.sendControl({ type: 'speech_generate_started', sessionId, turnId });
        }
        return;
      }

      const audioAvailable = audioArchive.findFinalized(sessionId, turnId, characters.current().name) !== null;
      if (audioAvailable) {
        client.sendControl({ type: 'speech_generate_completed', sessionId, turnId, audioAvailable });
      } else {
        client.sendControl({ type: 'speech_generate_unavailable', sessionId, turnId });
      }
      client.close();
    },
    detachSpeechSocket(_sessionId, turnId, client) {
      const job = jobs.get(turnId);
      if (job?.client === client) job.client = null;
    },
    async cancelTurnSpeech(turnId) {
      const job = jobs.get(turnId);
      if (job) await cancelJob(job);
    },
    async cancelSessionSpeech(sessionId) {
      const matching = [...jobs.values()].filter(job => job.sessionId === sessionId);
      await Promise.all(matching.map(cancelJob));
    },
    async close() {
      closed = true;
      await Promise.all([...jobs.values()].map(cancelJob));
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

interface SpeechJob {
  readonly sessionId: string;
  readonly turnId: string;
  readonly characterName: string;
  readonly abortController: AbortController;
  readonly signal: AbortSignal;
  readonly preparing: Promise<SpeechCoordinator>;
  readonly onAbort: () => void;
  client: SpeechSocketClient | null;
  audioReady: boolean;
  completion: Promise<TurnSpeechGenerateResult> | null;
}
