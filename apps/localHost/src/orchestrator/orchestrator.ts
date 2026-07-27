// 接收一次 Turn 请求，选择执行方式，并把执行过程整理成前端需要的事件流。

import type { AppBindings } from '../wiring/index.js';
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
import type { TurnStreamEvent } from '@ema-agent/events';
import type {
  TurnExecutor,
  TurnInputPreparer,
  TurnOutcome,
} from '@ema-agent/turn-execution';
import type { TurnSpeechOutput } from '@ema-agent/tts';
import { createTurnExecution } from '../wiring/createTurnExecution.js';
import { createTurnOutput } from '../wiring/createTurnOutput.js';

export interface TurnResult {
  turnId: TurnId;
  events: AsyncIterable<TurnStreamEvent>;
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
 * LocalHost 的 Turn 输入装配入口。Chat/Work 共用 TurnExecutor，只在执行策略、
 * Prompt 扩展和 Context Contribution 上保留产品差异。
 */
export class Orchestrator {
  private readonly turnExecutor: TurnExecutor;
  private readonly turnInputPreparer: TurnInputPreparer;
  private readonly turnSpeechOutput: TurnSpeechOutput;
  // LocalHost 迁移期只保留按 turnId 查找取消入口，不再复制 Session 运行注册表。
  private readonly activeTurns = new Map<string, { abort: () => void }>();

  constructor(bindings: AppBindings) {
    const turnExecution = createTurnExecution(bindings);
    this.turnExecutor = turnExecution.executor;
    this.turnInputPreparer = turnExecution.inputPreparer;
    this.turnSpeechOutput = createTurnOutput(bindings);
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
    const handle = this.turnExecutor.start({
      sessionId,
      triggerType: request.trigger.type,
      executionProfile: request.executionProfile,
      narrativePolicy: request.narrativePolicy,
      userInput: request.userInput,
      prepare: (context) => this.turnInputPreparer.prepare(request, context),
    });
    this.activeTurns.set(handle.turnId as string, { abort: handle.abort });
    void handle.completion.then(
      () => this.activeTurns.delete(handle.turnId as string),
      () => this.activeTurns.delete(handle.turnId as string),
    );

    return {
      turnId: handle.turnId,
      events: this.turnSpeechOutput.decorate({
        enabled: request.ttsEnabled ?? false,
        sessionId,
        turnId: handle.turnId,
        events: handle.events,
      }),
      completion: handle.completion,
    };
  }
}
