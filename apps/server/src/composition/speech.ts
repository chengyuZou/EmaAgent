import { randomUUID } from 'node:crypto';
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
  type SpeechGenerateEvent,
  type SpeechGenerationResult,
  type SpeechVoicePreviewTts,
  type SpeechArchiveEvent,
} from '@ema-agent/speech';
import {
  SpeechOutputsRepo,
  type Database,
} from '@ema-agent/storage';
import { createSttCall, SttError, type TranscriptionRequest, type TranscriptionResult } from '@ema-agent/stt';
import {
  createTtsCall,
  createTtsVoiceRegistrar,
  TtsError,
  type TtsVoiceReference,
} from '@ema-agent/tts';
import type { UsageRecorder } from '@ema-agent/usage';

// TODO: 前端接通原生 audio 的 URL 播放后移除暂停条件, 避免使用尚未替换的逐句播放器.
const REALTIME_SPEECH_PLAYBACK_AVAILABLE = false;

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
  /** 为一个根 Turn 启动语音输出 */
  startTurnSpeech(setup: {
    readonly sessionId: string;
    readonly turnId: string;
    readonly signal: AbortSignal;
  }): Promise<TurnSpeechHandle | null>;
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
  const audioArchive = new FsAudioArchive(path.join(activeDataDir, 'sessions'));
  const voiceCache = new SpeechVoiceCache();
  const speechOutputs = new SpeechOutputsRepo(dataDb.sqlite);
  const jobs = new Map<string, SpeechJob>();
  let closed = false;

  /** 获取当前角色的主参考音频 */
  const resolveCharacterVoice = (character: Character): TtsVoiceReference | null => {
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
      // 参考音频损坏只降级声音能力，不阻断文字对话。
      return null;
    }
  };

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

  const completeJob = (job: SpeechJob): Promise<void> => {
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

      const audioAvailable = result.audio !== null;
      try {
        if (result.audio) {
          speechOutputs.record({
            turnId: job.turnId,
            sessionId: job.sessionId,
            ...result.audio,
            createdAt: Date.now(),
          });
          // 先完成文件和 SQL 记录, 再通知 Chat / Storage 和当前播放连接.
          emitArchiveChanged({
            type: 'session_audio_changed',
            sessionId: job.sessionId,
            turnId: job.turnId,
          });
        }
        if (result.status === 'failed') {
          job.client?.sendControl({
            type: 'speech_generate_failed',
            sessionId: job.sessionId,
            turnId: job.turnId,
            audioAvailable,
            code: result.code,
            message: result.message,
          });
        } else {
          const type = result.status === 'cancelled'
            ? 'speech_generate_cancelled'
            : 'speech_generate_completed';
          job.client?.sendControl({ type, sessionId: job.sessionId, turnId: job.turnId, audioAvailable });
        }
      } catch (error) {
        console.warn(`[speech] Turn ${job.turnId} 音频记录保存失败:`, error);
        job.client?.sendControl({
          type: 'speech_generate_failed',
          sessionId: job.sessionId,
          turnId: job.turnId,
          audioAvailable,
          code: 'speech/audio_record_failed',
          message: error instanceof Error ? error.message : String(error),
        });
      } finally {
        job.signal.removeEventListener('abort', job.onAbort);
        jobs.delete(job.turnId);
        job.client?.close();
        job.client = null;
      }
    })();
    return job.completion;
  };

  const cancelJob = (job: SpeechJob): Promise<void> => {
    job.abortController.abort('speech cancelled');
    return completeJob(job);
  };

  const startTurnSpeech: SpeechComposition['startTurnSpeech'] = async setup => {
    if (closed || !REALTIME_SPEECH_PLAYBACK_AVAILABLE) return null;
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
    } catch (error) {
      if (error instanceof ProviderError || error instanceof TtsError) return null;
      throw error;
    }

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
      callTts,
      archive: audioArchive,
      signal,
      usageRecorder,
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

    try {
      const coordinator = await preparing;
      if (signal.aborted) {
        await completeJob(job);
        return null;
      }
      return {
        acceptTextDelta: delta => coordinator.acceptTextDelta(delta),
        finish: () => completeJob(job),
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
    const callStt = createSttCall(
      providers.resolveConnection(binding.providerId, 'stt'),
      binding.modelId,
    );
    const startedAt = Date.now();
    const callId = randomUUID();
    const result = await callStt(request).catch(error => {
      const cancelled = request.signal?.aborted === true || (error instanceof Error && error.name === 'AbortError');
      let errorCode = 'stt/call_failed';
      if (cancelled) errorCode = 'stt/aborted';
      else if (error instanceof SttError) errorCode = error.code;
      recordSttUsage(usageRecorder, callId, binding.providerId, binding.modelId, startedAt,
        cancelled ? 'cancelled' : 'failed', null, errorCode);
      throw error;
    });
    const lastEndMs = result.segments?.reduce((max, s) => Math.max(max, s.endMs), 0) ?? 0;
    recordSttUsage(usageRecorder, callId, binding.providerId, binding.modelId, startedAt, 'completed',
      lastEndMs > 0 ? lastEndMs / 1000 : null, null);
    return result;
  };

  /** STT 试听 当前角色主参考音频 -> 指定 Provider 模型转写 */
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
    const startedAt = Date.now();
    const callId = randomUUID();
    const result = await callStt({
      audio: new Uint8Array(audio),
      mimeType: sample.mimeType,
      ...(signal ? { signal } : {}),
    }).catch(error => {
      const cancelled = signal?.aborted === true || (error instanceof Error && error.name === 'AbortError');
      let errorCode = 'stt/call_failed';
      if (cancelled) errorCode = 'stt/aborted';
      else if (error instanceof SttError) errorCode = error.code;
      recordSttUsage(usageRecorder, callId, providerId, modelId, startedAt,
        cancelled ? 'cancelled' : 'failed', null, errorCode);
      throw error;
    });
    const lastEndMs = result.segments?.reduce((max, segment) => Math.max(max, segment.endMs), 0) ?? 0;
    recordSttUsage(usageRecorder, callId, providerId, modelId, startedAt, 'completed',
      lastEndMs > 0 ? lastEndMs / 1000 : null, null);
    return { text: result.text, referenceText: sample.promptText };
  };

  return {
    audioArchive,
    voicePreview,
    transcribe,
    sttPreview,
    startTurnSpeech,
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

      const audioAvailable = audioArchive.findFinalized(sessionId, turnId) !== null;
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

function recordSttUsage(
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
  readonly abortController: AbortController;
  readonly signal: AbortSignal;
  readonly preparing: Promise<SpeechCoordinator>;
  readonly onAbort: () => void;
  client: SpeechSocketClient | null;
  audioReady: boolean;
  completion: Promise<void> | null;
}
