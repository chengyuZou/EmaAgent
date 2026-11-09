import { randomUUID } from 'node:crypto';
import { logging } from '@ema-agent/logging';
import {
  createTTSCall,
  createTTSVoiceRegistrar,
  type CallTTS,
  type PcmAudioFormat,
  type TTSConnection,
  type TTSVoice,
  type TTSVoiceReference,
} from '@ema-agent/tts';
import type { UsageRecorder } from '@ema-agent/usage';
import { SentenceSplitter } from './filter/sentenceSplitter.js';
import { TextFilterStream, filterSentenceForTTS } from './filter/textFilter.js';
import { VoiceRegistrationCache } from './voiceRegistrationCache.js';
import { AudioStore } from './store/audioStore.js';
import type { AudioSegment, SpeechAudioIdentity, AudioPlayback, CharacterTag } from './types.js';
import type { SpeechGenerationEvent, SpeechGenerationResult } from './events.js';
import { SpeechRequestError, type SpeechGenerationFailure } from './errors.js';
import { generateVoicePreview, type VoicePreviewInput, type SpeechVoicePreviewResult } from './voicePreview.js';

const MAX_SENTENCE_PCM_BYTES = 16 * 1024 * 1024;
const SENTENCE_TIMEOUT_MS = 120_000;

export interface StartTurnSpeechInput {
  readonly sessionId: string;
  readonly turnId: string;
  /** 固定本次音频的角色归属, 不在每句合成时重新读取当前角色. */
  readonly characterName: string;
  readonly voiceReference: TTSVoiceReference;
  /** 用于用量和音色缓存归属, 连接地址本身不能代表 Provider 身份. */
  readonly providerId: string;
  readonly modelId: string;
  readonly connection: TTSConnection;
  /** 自动生成关联 Turn 的异常结束; 手动生成不绑定 HTTP 连接的断开. */
  readonly signal?: AbortSignal;
}

/** 本进程内的生成对象. HTTP/WS 只能发送明确的结果或事件, 不能序列化该对象. */
export interface SpeechGeneration extends SpeechAudioIdentity {
  /** 合成及文件/记录保存或丢弃完成后结束, 不等待前端播放完成. */
  readonly generationCompletion: Promise<SpeechGenerationResult>;
}

interface ActiveSpeechGeneration extends SpeechGeneration {
  readonly input: StartTurnSpeechInput;
  readonly callTTS: CallTTS;
  readonly preparedVoice: Promise<TTSVoice>;
  // TextFilterStream 会跨正文增量保留代码块, 数学块和行首状态.
  // 不同 Session 的正文可能交错到达, 必须每次生成单独创建, 避免把另一条回复误当成块内内容过滤掉.
  readonly textFilter: TextFilterStream;
  // SentenceSplitter.buffer 保留本次尚未成句的正文, 必须跟随本次生成单独保存.
  // 即使两次生成使用同一个角色也不能共用, 否则不同回复的片段可能被拼成同一句提交给 TTS.
  readonly sentenceSplitter: SentenceSplitter;
  readonly abortController: AbortController;
  readonly onExternalAbort: () => void;
  readonly onGenerationAbort: () => void;
  readonly resolveGeneration: (result: SpeechGenerationResult) => void;
  /** 自动生成保存已写入部分; 手动生成失败只清理本次 AudioID, 不影响之前的录音. */
  readonly keepPartialAudio: boolean;
  /** 正文封口后不再接受增量, 已排队的句子仍需完成或取消. */
  textInputEnded: boolean;
  /** 当前及排队句子的完成链, 不包含最终 WAV 发布和 SQL 提交. */
  queuedSynthesisCompletion: Promise<void>;
  generationFailure: SpeechGenerationFailure | null;
}

export class SpeechGenerator {
  /** 声音准备前登记, 文件保存或丢弃后移除. 返回的 speechGeneration 就是这里的同一对象. */
  private readonly activeGenerationsByAudioId = new Map<string, ActiveSpeechGeneration>();
  private readonly voiceRegistrationCache = new VoiceRegistrationCache();
  /** 非 null 表示已拒绝新生成并正在等待现有生成收尾. */
  private shutdownCompletion: Promise<void> | null = null;

  constructor(
    readonly audioStore: AudioStore,
    private readonly usageRecorder: UsageRecorder,
    private readonly emitSpeechEvent: (event: SpeechGenerationEvent) => void,
  ) {}

  startTurnSpeech(input: StartTurnSpeechInput): SpeechGeneration {
    return this.beginGeneration(input, true);
  }

  previewVoice(input: VoicePreviewInput): Promise<SpeechVoicePreviewResult> {
    return generateVoicePreview(input, this.voiceRegistrationCache, this.usageRecorder);
  }

  async generateTurnAudio(input: StartTurnSpeechInput, replyText: string): Promise<SpeechGenerationResult> {
    const speechGeneration = this.beginGeneration(input, false);
    this.appendTextDelta(speechGeneration.audioId, replyText);
    this.endTextInput(speechGeneration.audioId);
    return speechGeneration.generationCompletion;
  }

  /** 返回只表示正文已接收, 不表示音色已准备好或这一段已合成. */
  appendTextDelta(
    audioId: string,
    textDelta: string,
    tags: readonly CharacterTag[] | null = null,
  ): void {
    const speechGeneration = this.activeGenerationsByAudioId.get(audioId);
    if (!speechGeneration || speechGeneration.textInputEnded) return;
    const filteredText = speechGeneration.textFilter.feed(textDelta);
    const sentences = speechGeneration.sentenceSplitter.feed(filteredText);
    if (tags?.length) {
      // 标签是强制分段点, 只交出分句器的文字, 不重置代码和数学块过滤状态.
      sentences.push(...speechGeneration.sentenceSplitter.flush());
    }
    for (const [sentenceIndex, sentence] of sentences.entries()) {
      const sentenceTags = sentenceIndex === sentences.length - 1 ? tags : null;
      this.enqueueSentence(speechGeneration, sentence, sentenceTags);
    }
    // 没有前文时保留纯标签输入. 不合成空声音, 也不制造带空字符串的 TTS 请求.
    if (sentences.length === 0 && tags?.length) this.enqueueSentence(speechGeneration, null, tags);
  }

  /** 正常 Turn 结束只封口. 调用者观察 generationCompletion, 不在事件分发中等待它. */
  endTextInput(audioId: string): void {
    const speechGeneration = this.activeGenerationsByAudioId.get(audioId);
    if (!speechGeneration || speechGeneration.textInputEnded) return;
    speechGeneration.textInputEnded = true;
    if (!speechGeneration.abortController.signal.aborted && !speechGeneration.generationFailure) {
      const remainingText = speechGeneration.textFilter.flush();
      const sentences = [
        ...speechGeneration.sentenceSplitter.feed(remainingText),
        ...speechGeneration.sentenceSplitter.flush(),
      ];
      for (const sentence of sentences) this.enqueueSentence(speechGeneration, sentence);
    }
    void this.finishGeneration(speechGeneration);
  }

  findGeneration(audioId: string): SpeechGeneration | null {
    return this.activeGenerationsByAudioId.get(audioId) ?? null;
  }

  getAudioPlayback(audioId: string): AudioPlayback | null {
    return this.audioStore.getAudioPlayback(audioId);
  }

  async cancelGeneration(audioId: string): Promise<void> {
    const speechGeneration = this.activeGenerationsByAudioId.get(audioId);
    if (!speechGeneration) return;
    speechGeneration.abortController.abort('speech cancelled');
    await speechGeneration.generationCompletion;
  }


  async cancelSessionSpeech(sessionId: string): Promise<void> {
    const matching = [...this.activeGenerationsByAudioId.values()]
      .filter(speechGeneration => speechGeneration.sessionId === sessionId);
    await Promise.all(matching.map(speechGeneration => this.cancelGeneration(speechGeneration.audioId)));
  }

  /** 等待所有文件收尾, 不关闭由 Server 共享的数据库或 logging. */
  close(): Promise<void> {
    this.shutdownCompletion ??= Promise.resolve().then(async () => {
      await Promise.all([...this.activeGenerationsByAudioId.keys()].map(audioId => this.cancelGeneration(audioId)));
    });
    return this.shutdownCompletion;
  }

  private beginGeneration(input: StartTurnSpeechInput, keepPartialAudio: boolean): ActiveSpeechGeneration {
    if (this.shutdownCompletion) throw new SpeechRequestError('speech/closed', '语音生成器已关闭');
    if ([...this.activeGenerationsByAudioId.values()].some(generation =>
      generation.turnId === input.turnId && generation.characterName === input.characterName
    )) {
      throw new SpeechRequestError('speech/already_generating', '该轮的这个角色正在生成语音, 请等待完成或先取消');
    }
    const fixedInput = {
      ...input,
      connection: { ...input.connection },
      voiceReference: { ...input.voiceReference },
    };
    const callTTS = createTTSCall(fixedInput.connection, fixedInput.modelId);
    const abortController = new AbortController();
    let resolveGeneration!: (result: SpeechGenerationResult) => void;
    const generationCompletion = new Promise<SpeechGenerationResult>(resolve => {
      resolveGeneration = resolve;
    });
    const audioId = randomUUID();
    // 记录插入失败时不会准备声音或创建文件. generating 会在成功收尾或失败清理后离开.
    this.audioStore.createAudioRecord({ audioId, sessionId: input.sessionId, turnId: input.turnId, characterName: input.characterName });
    const preparedVoice = Promise.resolve().then(() => this.voiceRegistrationCache.prepare({
      reference: fixedInput.voiceReference,
      ttsVoiceRegistrar: createTTSVoiceRegistrar(fixedInput.connection, fixedInput.modelId),
      characterName: fixedInput.characterName,
      providerId: fixedInput.providerId,
      modelId: fixedInput.modelId,
      signal: abortController.signal,
    }));
    const speechGeneration: ActiveSpeechGeneration = {
      audioId,
      sessionId: input.sessionId,
      turnId: input.turnId,
      characterName: input.characterName,
      input: fixedInput,
      callTTS,
      preparedVoice,
      abortController,
      generationCompletion,
      resolveGeneration,
      textFilter: new TextFilterStream(),
      sentenceSplitter: new SentenceSplitter(),
      keepPartialAudio,
      textInputEnded: false,
      generationFailure: null,
      onExternalAbort: () => abortController.abort(input.signal?.reason),
      onGenerationAbort: () => this.endTextInput(audioId),
      queuedSynthesisCompletion: Promise.resolve(),
    };
    this.activeGenerationsByAudioId.set(audioId, speechGeneration);
    this.audioStore.segments.beginGeneration(audioId);
    // 准备失败也纳入同一条完成链, 尚未收到正文时也能取消并清理登记.
    speechGeneration.queuedSynthesisCompletion = preparedVoice.then(() => undefined).catch(error => {
      this.failGeneration(speechGeneration, 'speech/prepare_failed', error);
    });
    abortController.signal.addEventListener('abort', speechGeneration.onGenerationAbort, { once: true });
    input.signal?.addEventListener('abort', speechGeneration.onExternalAbort, { once: true });
    if (input.signal?.aborted) speechGeneration.onExternalAbort();
    return speechGeneration;
  }

  private enqueueSentence(
    speechGeneration: ActiveSpeechGeneration,
    text: string | null,
    tags: readonly CharacterTag[] | null = null,
  ): void {
    speechGeneration.queuedSynthesisCompletion = speechGeneration.queuedSynthesisCompletion
      .then(() => this.synthesizeSentence(speechGeneration, text, tags))
      .catch(error => this.failGeneration(speechGeneration, 'speech/generate_failed', error));
  }

  private failGeneration(speechGeneration: ActiveSpeechGeneration, code: string, error: unknown): void {
    if (!speechGeneration.abortController.signal.aborted) {
      speechGeneration.generationFailure ??= { code, message: errorMessage(error) };
      speechGeneration.abortController.abort(error);
    }
    this.endTextInput(speechGeneration.audioId);
  }

  private async synthesizeSentence(
    speechGeneration: ActiveSpeechGeneration,
    sourceText: string | null,
    tags: readonly CharacterTag[] | null,
  ): Promise<void> {
    if (speechGeneration.abortController.signal.aborted) return;
    const textForTTS = sourceText === null ? null : filterSentenceForTTS(sourceText);
    if (!textForTTS) {
      if (tags) {
        const part = this.audioStore.segments.beginSegment(
          speechGeneration.audioId, null,
          this.audioStore.files.getWrittenDurationMs(speechGeneration.audioId), tags,
        );
        this.emitSegments(speechGeneration, [part]);
      }
      return;
    }
    const voice = await speechGeneration.preparedVoice;
    const startedAt = Date.now();
    const timeoutSignal = AbortSignal.timeout(SENTENCE_TIMEOUT_MS);
    const signal = AbortSignal.any([speechGeneration.abortController.signal, timeoutSignal]);
    // 这是供应商已交付的字节数, 用于限制单句大小; 实际落盘数量由 AudioFileStore 记录.
    let receivedSentencePCMBytes = 0;
    let format: PcmAudioFormat | undefined;
    let audioSegment: AudioSegment | null = null;
    let fileWriteFailed = false;
    let errorCode: string | null = null;
    try {
      for await (const event of speechGeneration.callTTS({ text: textForTTS, voice, signal })) {
        signal.throwIfAborted();
        if (event.type === 'audio_started') {
          format = { sampleRate: event.sampleRate, channelCount: event.channelCount };
        } else if (event.type === 'audio_chunk') {
          receivedSentencePCMBytes += event.bytes.byteLength;
          if (receivedSentencePCMBytes > MAX_SENTENCE_PCM_BYTES) throw new Error('TTS sentence exceeds the PCM byte limit');
          const startMs = this.audioStore.files.getWrittenDurationMs(speechGeneration.audioId);
          try {
            await this.audioStore.files.appendPCM(this.identity(speechGeneration), format!, event.bytes);
          } catch (error) {
            fileWriteFailed = true;
            throw error;
          }
          if (!audioSegment) {
            audioSegment = this.audioStore.segments.beginSegment(speechGeneration.audioId, textForTTS, startMs, tags);
            this.emitSegments(speechGeneration, [audioSegment]);
          }
        }
      }
      signal.throwIfAborted();
    } catch (error) {
      if (speechGeneration.abortController.signal.aborted) {
        errorCode = 'tts/cancelled';
      } else {
        errorCode = timeoutSignal.aborted ? 'tts/timeout' : ttsErrorCode(error);
        if (fileWriteFailed || !speechGeneration.keepPartialAudio) {
          this.failGeneration(speechGeneration, errorCode, error);
        } else {
          this.emit({
            ...this.identity(speechGeneration),
            type: 'speech_generate_warning',
            code: errorCode,
            message: errorMessage(error),
          });
        }
      }
    } finally {
      if (audioSegment) {
        const completedSegment = this.audioStore.segments.finishSegment(
          speechGeneration.audioId,
          audioSegment.segmentIndex,
          this.audioStore.files.getWrittenDurationMs(speechGeneration.audioId),
        );
        this.emitSegments(speechGeneration, [completedSegment]);
      }
      let requestStatus: 'completed' | 'failed' | 'cancelled' = 'completed';
      if (errorCode === 'tts/cancelled') requestStatus = 'cancelled';
      else if (errorCode) requestStatus = 'failed';
      this.usageRecorder.record({
        id: randomUUID(),
        sessionId: speechGeneration.sessionId,
        turnId: speechGeneration.turnId,
        capability: 'tts',
        providerId: speechGeneration.input.providerId,
        modelId: speechGeneration.input.modelId,
        status: requestStatus,
        durationMs: Date.now() - startedAt,
        quantity: textForTTS.length,
        unit: 'character',
        inputTokens: null,
        outputTokens: null,
        cacheReadInputTokens: null,
        cacheWriteInputTokens: null,
        errorCode,
        createdAt: startedAt,
      });
    }
  }

  private async finishGeneration(speechGeneration: ActiveSpeechGeneration): Promise<void> {
    await speechGeneration.queuedSynthesisCompletion;
    let hasSavedAudio = false;
    try {
      const isGenerationInterrupted = speechGeneration.abortController.signal.aborted || speechGeneration.generationFailure !== null;
      const hasWrittenAudio = this.audioStore.files.getWrittenDurationMs(speechGeneration.audioId) > 0;
      if (isGenerationInterrupted && (!speechGeneration.keepPartialAudio || !hasWrittenAudio)) {
        await this.audioStore.discardFailedAudio(
          speechGeneration.audioId,
          speechGeneration.generationFailure?.message ?? '本次语音生成已取消',
        );
      } else {
        const audioSummary = await this.audioStore.saveCompletedAudio(
          speechGeneration.audioId,
          this.audioStore.segments.getCompletedSegments(speechGeneration.audioId),
          speechGeneration.keepPartialAudio ? undefined : speechGeneration.abortController.signal,
        );
        hasSavedAudio = audioSummary !== null;
      }
    } catch (error) {
      if (error instanceof SpeechRequestError && error.code === 'speech/audio_status_save_failed') {
        const originalMessage = speechGeneration.generationFailure?.message;
        speechGeneration.generationFailure = {
          code: error.code,
          message: originalMessage ? originalMessage + '; ' + error.message : error.message,
        };
      } else if (!speechGeneration.abortController.signal.aborted || speechGeneration.generationFailure) {
        speechGeneration.generationFailure ??= { code: 'speech/audio_save_failed', message: errorMessage(error) };
      }
    }
    const isCancelledWithoutAudio = speechGeneration.abortController.signal.aborted && !hasSavedAudio;
    if (!speechGeneration.keepPartialAudio && !hasSavedAudio && !isCancelledWithoutAudio && !speechGeneration.generationFailure) {
      speechGeneration.generationFailure = { code: 'speech/no_audio', message: '该轮没有可保存的语音' };
    }
    const identity = this.identity(speechGeneration);
    let audioAvailable = false;
    try {
      audioAvailable = this.audioStore.outputs.findByAudioId(identity.audioId)?.audioStatus === 'ready';
    } catch (error) {
      // 保存结果查询失败仍需结束生成并释放登记, 不能让关闭应用一直等待这个 Promise.
      speechGeneration.generationFailure ??= { code: 'speech/audio_lookup_failed', message: errorMessage(error) };
    }
    let result: SpeechGenerationResult;
    if (speechGeneration.generationFailure) {
      result = { ...identity, type: 'speech_generate_failed', audioAvailable, ...speechGeneration.generationFailure };
    } else {
      // 自动取消仍可能保存部分文件; 手动生成在 SQL 提交后才收到取消, 则保留已完成结果.
      const isCancelled = speechGeneration.abortController.signal.aborted
        && (speechGeneration.keepPartialAudio || !hasSavedAudio);
      result = { ...identity, type: isCancelled ? 'speech_generate_cancelled' : 'speech_generate_completed', audioAvailable };
    }
    speechGeneration.input.signal?.removeEventListener('abort', speechGeneration.onExternalAbort);
    speechGeneration.abortController.signal.removeEventListener('abort', speechGeneration.onGenerationAbort);
    this.activeGenerationsByAudioId.delete(identity.audioId);
    this.audioStore.segments.releaseGeneration(identity.audioId);
    this.emit(result);
    speechGeneration.resolveGeneration(result);
  }

  private identity(speechGeneration: SpeechAudioIdentity): SpeechAudioIdentity {
    return {
      audioId: speechGeneration.audioId,
      sessionId: speechGeneration.sessionId,
      turnId: speechGeneration.turnId,
      characterName: speechGeneration.characterName,
    };
  }

  private emitSegments(speechGeneration: SpeechGeneration, segments: readonly AudioSegment[]): void {
    this.emit({ ...this.identity(speechGeneration), type: 'speech_segments', segments });
  }

  private emit(event: SpeechGenerationEvent): void {
    try {
      this.emitSpeechEvent(event);
    } catch (error) {
      // 文件保存完成后不能因通知失败撤回, 通知失败也不能让生成完成 Promise 悬空.
      logging({
        level: 'warn',
        target: 'speech',
        event: 'speech.notification_failed',
        error,
        body: { audioId: event.audioId },
      });
    }
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function ttsErrorCode(error: unknown): string {
  const code = (error as { code?: unknown })?.code;
  return typeof code === 'string' && code.startsWith('tts/') ? code : 'tts/synthesis_failed';
}

