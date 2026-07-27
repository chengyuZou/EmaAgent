// 接收一次 Turn 请求，选择执行方式，并把执行过程整理成前端需要的事件流。

import type {
  AppBindings } from '../wiring/index.js';
import type {
  TurnId,
  SessionId,
} from '@ema-agent/ids';
import type {
  ExecutionProfile,
  KbAssetScope,
  NarrativePolicy,
  TurnTrigger,
} from '@ema-agent/turn';
import type { ThinkingMode } from '@ema-agent/llm';
import type { LlmContentPart } from '@ema-agent/llm';
import type { AttachmentInput } from '@ema-agent/attachment';
import {
  asSessionId,
} from '@ema-agent/ids';
import type { EmaStreamEvent } from '@ema-agent/events';
import {
  TurnContextBuilder,
  TurnExecutor,
  TurnInputPreparer,
  TurnToolsBuilder,
  type TurnOutcome,
} from '@ema-agent/turn-execution';
import { TtsCoordinator }     from '@ema-agent/tts';
import type { FinalizedAudio } from '@ema-agent/tts';
import { SettingsRepo } from '@ema-agent/storage';
import { resolveVoice, ensureVoiceUri, VoiceUriCache } from '../wiring/providers/tts.js';
import { ensureSessionLayout, scratchpadTurnDir } from '../storage-locations/index.js';

const TURN_ATTACHMENT_CAPTION_PROMPT_REVISION = 'turn-attachment-caption-v1';

export interface TurnResult {
  turnId: TurnId;
  events: AsyncIterable<EmaStreamEvent>;
  completion?: Promise<TurnOutcome>;
}

export interface TurnRequest {
  sessionId:        string;
  trigger:          TurnTrigger;
  executionProfile: ExecutionProfile;
  narrativePolicy:  NarrativePolicy;
  userInput:        string;
  contentParts?:    LlmContentPart[];
  /** 前端提交的本轮附件；进入执行器前完成持久化和模型输入解析。 */
  attachmentInputs?: AttachmentInput[];
  /** provider_configs.id — 和 model 成对使用，前端选择器选的是 (provider, model) 组合。 */
  providerId?:      string;
  model?:           string;
  /** 用户在聊天选择器中选中的知识库，是本轮检索范围。 */
  kbIds?:           string[];
  /** 聊天选择器为每个知识库指定的文档范围。 */
  kbAssetScopes?:   KbAssetScope[];
  /**
   * 是否为本轮启用语音合成，默认关闭，由前端扬声器开关逐轮选择。
   * 关闭时不创建合成任务，也不发送 tts_chunk 事件。
   */
  ttsEnabled?:  boolean;
  /** 用户选择的思考模式；只有用户开启且模型支持时才会发送。 */
  thinking?:    ThinkingMode;
}

/**
 * Route 通过窄回调接收旁路结果，避免 Orchestrator 反向导入 Route 形成循环依赖。
 */
export interface OrchestratorCallbacks {
  /**
   * 合并音频落盘后通知 Route 清理可由音频接口重放的内存 Base64 分块。
   * 本轮未启用 TTS 或全部句子合成失败时 audio 为 null。
   */
  onAudioFinalized?: (turnId: TurnId, sessionId: SessionId, audio: FinalizedAudio | null) => void;
}

/**
 * LocalHost 的 Turn 输入装配入口。Chat/Work 共用 TurnExecutor，只在执行策略、
 * Prompt 扩展和 Context Contribution 上保留产品差异。
 */
export class Orchestrator {
  private readonly turnExecutor: TurnExecutor;
  private readonly turnInputPreparer: TurnInputPreparer;
  private readonly callbacks:    OrchestratorCallbacks;
  // LocalHost 迁移期只保留按 turnId 查找取消入口，不再复制 Session 运行注册表。
  private readonly activeTurns = new Map<string, { abort: () => void }>();

  constructor(
    private readonly bindings:   AppBindings,
    callbacks:                   OrchestratorCallbacks = {},
  ) {
    this.callbacks = callbacks;
    this.turnInputPreparer = new TurnInputPreparer({
      session: bindings.session,
      attachments: bindings.attachmentStore,
      modelCapabilities: bindings.modelCapabilities,
      contextWindowFor: (providerId, model) =>
        bindings.providerLlmModels.contextWindowFor(providerId, model),
      activeCharacter: () => bindings.card.current(),
      extensionPromptContributions: (executionProfile) => {
        if (executionProfile !== 'work') return [];
        const contribution = bindings.skillRunner.promptContribution(executionProfile);
        return contribution ? [contribution] : [];
      },
      scratchpadDirForTurn: (sessionId, turnId) =>
        scratchpadTurnDir(
          bindings.activeDataDir,
          sessionId,
          turnId as string,
        ),
      mediaCompatibility: {
        visionBinding: () => bindings.modelBindings.get('vision'),
        describeImage: async ({
          providerId,
          model,
          image,
          sessionId,
          turnId,
          signal,
        }) => {
          const cached = await bindings.attachmentDerivationCache.getOrCreate({
            source: {
              kind: 'base64',
              data: image.data,
              name: image.name,
            },
            task: 'caption',
            providerConfigId: providerId,
            modelId: model,
            promptRevision: TURN_ATTACHMENT_CAPTION_PROMPT_REVISION,
            signal,
          }, async (normalizedImage) => {
            const result = await bindings.vision.extract({
              providerId,
              model,
              task: 'caption',
              inputs: [{
                kind: 'bytes',
                bytes: normalizedImage.bytes,
                mimeType: normalizedImage.mimeType,
                name: image.name,
              }],
              context: {
                caller: 'turn_attachment',
                sessionId: sessionId as string,
                turnId: turnId as string,
              },
              signal,
            });
            return result.text;
          });
          return cached.text;
        },
      },
    });
    this.turnExecutor = new TurnExecutor(
      {
        session:           bindings.session,
        hooks:             bindings.hooks,
        llm:               bindings.llm,
        emotion:           bindings.emotion,
      },
      new TurnContextBuilder({
        session: bindings.session,
        memory: bindings.memory,
        tasks: bindings.taskStore,
        narrative: bindings.narrative,
        compactor: bindings.contextCompactor,
      }),
      new TurnToolsBuilder({
        session: bindings.session,
        tools: bindings.tools,
        permission: bindings.permission,
        hooks: bindings.hooks,
        llm: bindings.llm,
        narrative: bindings.narrative,
        getCommandRunner: bindings.getCommandRunner,
        buildAsk: bindings.buildAskForTurn,
        askUserInteraction: bindings.askUserRegistry,
        skillRunner: bindings.skillRunner,
        knowledgeSearch: bindings.kbSearch,
        getSessionToolResultStore: bindings.getSessionToolResultStore,
        agentRunStore: bindings.agentRunStore,
        taskStore: bindings.taskStore,
        toolExecutionJournal: bindings.toolExecutionJournal,
      }),
    );
  }

  /** 请求停止指定 Turn；Turn 已结束或不存在时无操作。 */
  abort(turnId: TurnId): void {
    this.activeTurns.get(turnId as string)?.abort();
  }

  /** 只取消一个子 Agent，不中止父 Turn。 */
  abortSubagent(turnId: TurnId, subagentId: string): void {
    this.turnExecutor.abortAgentRun(turnId as string, subagentId);
  }

  /** 只取消一个运行中的工具调用，不中止父 Turn。 */
  abortTool(turnId: TurnId, callId: string): boolean {
    return this.turnExecutor.abortTool(turnId as string, callId);
  }

  async run(request: TurnRequest): Promise<TurnResult> {
    const sessionId = asSessionId(request.sessionId);
    ensureSessionLayout(this.bindings.activeDataDir, sessionId as string);

    const handle = this.turnExecutor.start({
      sessionId,
      triggerType: request.trigger.type,
      executionProfile: request.executionProfile,
      narrativePolicy: request.narrativePolicy,
      userInput: request.userInput,
      prepare: (context) => this.turnInputPreparer.prepare(request, context),
    });
    this.activeTurns.set(handle.turnId as string, { abort: handle.abort });

    // TTS 仍由 LocalHost 负责，不取得根 Turn 的取消控制器。终态到达或流关闭时
    // 单独取消旁路音频，避免把媒体生命周期反向塞进 TurnExecutor。
    const ttsController = new AbortController();
    const events = await this.mergeWithTts(
      request,
      handle.turnId,
      sessionId,
      ttsController.signal,
      handle.events,
      () => {
        ttsController.abort();
        this.activeTurns.delete(handle.turnId as string);
      },
    );

    return {
      turnId: handle.turnId,
      events,
      completion: handle.completion,
    };
  }

  /**
   * TTS 是 Turn 输出的旁路增强。终态事件必须等音频收尾后最后发送，
   * TTS 初始化或归档失败不得改变模型执行终态。
   */
  private async mergeWithTts(
    request: TurnRequest,
    turnId: TurnId,
    sessionId: ReturnType<typeof asSessionId>,
    signal: AbortSignal,
    engineEvents: AsyncIterable<EmaStreamEvent>,
    onFinally: () => void,
  ): Promise<AsyncIterable<EmaStreamEvent>> {
    const ttsQueue: EmaStreamEvent[] = [];
    let ttsSignal = armSignal();
    const pushTts = (event: EmaStreamEvent): void => {
      ttsQueue.push(event);
      ttsSignal.fire();
    };

    let coordinator: TtsCoordinator | null = null;
    try {
      coordinator = await this.maybeBuildCoordinator(
        request,
        turnId,
        sessionId,
        signal,
        pushTts,
      );
    } catch (error) {
      pushTts({
        type: 'tts_warning',
        sessionId,
        turnId,
        code: 'tts/setup_failed',
        severity: 'warn',
        message: `TTS 初始化失败，本轮无语音：${error instanceof Error ? error.message : String(error)}`,
      });
    }

    const { callbacks } = this;
    return (async function* () {
      try {
        while (ttsQueue.length > 0) yield ttsQueue.shift()!;

        let pendingTurnDone: EmaStreamEvent | null = null;
        for await (const event of mergeStreams(engineEvents, coordinator, ttsQueue, () => {
          ttsSignal = armSignal();
          return ttsSignal.promise;
        })) {
          if (
            event.type === 'turn_completed'
            || event.type === 'turn_failed'
            || event.type === 'turn_aborted'
          ) {
            pendingTurnDone = event;
            continue;
          }
          yield event;
        }

        if (coordinator && pendingTurnDone?.type === 'turn_completed') {
          const { audio } = await coordinator.finish();
          while (ttsQueue.length > 0) yield ttsQueue.shift()!;
          callbacks.onAudioFinalized?.(turnId, sessionId, audio);
        } else if (coordinator) {
          await coordinator.abort();
          ttsQueue.length = 0;
          callbacks.onAudioFinalized?.(turnId, sessionId, null);
        }

        if (pendingTurnDone) yield pendingTurnDone;
      } catch (error) {
        if (coordinator) {
          await coordinator.abort();
          callbacks.onAudioFinalized?.(turnId, sessionId, null);
        }
        throw error;
      } finally {
        onFinally();
      }
    })();
  }

  private async maybeBuildCoordinator(
    request:   TurnRequest,
    turnId:    TurnId,
    sessionId: ReturnType<typeof asSessionId>,
    signal:    AbortSignal,
    emit:      (ev: EmaStreamEvent) => void,
  ): Promise<TtsCoordinator | null> {
    if (!request.ttsEnabled) return null;

    // 每个门禁都记录跳过原因，避免“已开启 TTS 但没有声音”只能靠猜。
    const bindingRow = this.bindings.modelBindings.get('tts');
    if (!bindingRow) {
      console.warn('[tts] no audio: no `tts` model binding configured');
      return null;
    }

    const card  = this.bindings.card.current();
    const voice = resolveVoice(card.id, this.bindings.card);
    if (!voice) {
      console.warn(`[tts] no audio: card "${card.id}" has no reference audio registered (voiceProfile.refAudios empty)`);
      return null;
    }

    // 缓存命中时复用 voiceUri；未命中时上传并持久化。
    const adapter = this.bindings.tts.getAdapter(bindingRow.providerConfigId);
    if (!adapter) {
      console.warn(`[tts] no audio: no TTS adapter for provider ${bindingRow.providerConfigId}`);
      return null;
    }
    const model   = bindingRow.model;
    const cache = new VoiceUriCache(new SettingsRepo(this.bindings.profileDb.sqlite));
    await ensureVoiceUri(voice, adapter, model, card.id, bindingRow.providerConfigId, cache, signal);

    // GPT-SoVITS 直接读取参考音频路径；云端适配器则必须取得 voiceUri。
    if (!voice.voiceUri && adapter.protocol !== 'gpt-sovits-tts') {
      console.warn(`[tts] no audio: cloud adapter ${adapter.protocol} requires a voiceUri but upload/cache produced none`);
      return null;
    }

    return new TtsCoordinator({
      turnId,
      sessionId,
      voice,
      providerId: bindingRow.providerConfigId,
      model,
      ttsClient:  this.bindings.tts,
      emit,
      archive:    this.bindings.audioArchive,
      format:     'mp3',
      signal,
    });
  }
}

// ── 单次唤醒信号 ─────────────────────────────────────────────────────────────

/** Node 20 环境下手写的一次性 Promise 唤醒信号。 */
function armSignal(): { promise: Promise<void>; fire: () => void } {
  let fire!: () => void;
  const promise = new Promise<void>((r) => { fire = r; });
  return { promise, fire };
}

// ── 事件流合并 ───────────────────────────────────────────────────────────────
//
// 按到达顺序合并根 Turn 与 TTS 事件。Turn 结束后先排空已产生的音频事件；
// 尚在合成的任务由调用方执行 coordinator.finish() 等待，本循环不重复等待。

async function* mergeStreams(
  engineEvents:    AsyncIterable<EmaStreamEvent>,
  coordinator:     TtsCoordinator | null,
  queue:           EmaStreamEvent[],
  waitForTtsPush:  () => Promise<void>,
): AsyncGenerator<EmaStreamEvent, void, void> {
  if (!coordinator) {
    yield* engineEvents;
    return;
  }

  const iter = engineEvents[Symbol.asyncIterator]();
  let nextEngine: Promise<IteratorResult<EmaStreamEvent>> | null = null;
  let engineDone = false;

  while (!engineDone || queue.length > 0) {
    while (queue.length > 0) yield queue.shift()!;

    if (engineDone) break;

    if (!nextEngine) nextEngine = iter.next();

    const winner = await Promise.race([
      nextEngine.then((r) => ({ kind: 'engine' as const, r })),
      waitForTtsPush().then(() => ({ kind: 'tts' as const })),
    ]);

    if (winner.kind === 'engine') {
      nextEngine = null;
      if (winner.r.done) {
        engineDone = true;
      } else {
        if (winner.r.value.type === 'output_text_delta') {
          coordinator.acceptTextDelta(winner.r.value.delta);
        }
        yield winner.r.value;
      }
    }
    // TTS 先到达时回到循环顶部排空队列。
  }
}
