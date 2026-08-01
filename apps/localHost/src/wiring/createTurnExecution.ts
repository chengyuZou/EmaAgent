// 集中装配根 Turn 的输入准备、Context、工具与 Agent 执行对象图。

import {
  RootAgentExecution,
  TurnContextBuilder,
  TurnExecutor,
  TurnInputPreparer,
  TurnToolsBuilder,
  executionProfilePolicy,
} from '@ema-agent/turn-execution';
import { assembleToolPrompt, type BuiltinToolContext } from '@ema-agent/tool-builtin';
import { agentSetting } from '@ema-agent/agent';
import {
  ContextCompactor,
  contextCompactionSetting,
} from '@ema-agent/context';
import { attachmentSetting } from '@ema-agent/attachment';
import { recordCompletedTurnMemory } from '@ema-agent/memory';
import type { AppBindings } from './bindings.js';
import { scratchpadTurnDir } from '../storage-locations/index.js';

const TURN_ATTACHMENT_CAPTION_PROMPT_REVISION = 'turn-attachment-caption-v1';

/**
 * LocalHost 的 Turn 执行组合根。
 *
 * AppBindings 只允许在装配边界展开；调用方只取得请求准备和执行入口，
 * 不再知道 Context、工具和根 Agent 之间如何构造与连接。
 */
export function createTurnExecution(bindings: AppBindings): {
  readonly executor: TurnExecutor;
  readonly inputPreparer: TurnInputPreparer;
} {
  // Compactor 拥有跨 Turn 的 Session 熔断状态，只在根 Turn 对象图中构造一次。
  const contextCompactor = new ContextCompactor({
    llm: bindings.llm,
    persistSummary: input => bindings.session.appendMessage(input),
  });

  const inputPreparer = new TurnInputPreparer({
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
    toolPromptContribution: async ({
      sessionId, turnId, executionProfile, narrativePolicy, workspaceRoot,
    }) => {
      // L1 时刻的可见性 Context:身份与 bindings 层服务全部真实;
      // per-Turn 构造物(narrativeSearch/activeSkillState/subagentSpawner/scratchpad)
      // 以占位表示——可见性检查只看存在性,说明书只读冻结字段。
      // 任何一边新增 per-Turn 能力键都必须同步这里。
      const policy = executionProfilePolicy(
        executionProfile,
        bindings.settings.get(agentSetting),
      );
      const hostContext = {
        sessionId,
        turnId,
        workspaceRoot,
        platform: process.platform,
        signal: new AbortController().signal,
        commandRunner: bindings.getCommandRunner?.(sessionId),
        backgroundProcesses: bindings.backgroundProcesses,
        taskStore: bindings.taskStore,
        skillRunner: bindings.skillRunner,
        knowledgeSearch: bindings.kbSearch,
        narrativeSearch: narrativePolicy !== 'off' ? {} : undefined,
        activeSkillState: {},
        subagentSpawner: {},
        askUser: () => Promise.resolve({ answers: {} }),
        scratchpad: executionProfile === 'work' ? {} : undefined,
      } as unknown as BuiltinToolContext;
      const assembly = await assembleToolPrompt(
        bindings.tools,
        hostContext,
        policy.allowedToolIds,
      );
      return assembly
        ? { id: 'tools.prompt', content: assembly.content, version: assembly.version }
        : null;
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
        normalization,
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
          normalization,
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
    settingsForTurn: () => ({
      agent: bindings.settings.get(agentSetting),
      attachment: bindings.settings.get(attachmentSetting),
      contextCompaction: bindings.settings.get(contextCompactionSetting),
    }),
  });

  const executor = new TurnExecutor(
    {
      session: bindings.session,
      interactions: bindings.interactionQueue,
      completedObserver: {
        record: (turn) => recordCompletedTurnMemory(
          bindings.session,
          bindings.memory,
          turn,
        ),
      },
    },
    new RootAgentExecution(
      {
        transcript: bindings.session,
        llm: bindings.llm,
        emotion: bindings.emotion,
      },
      new TurnContextBuilder({
        session: bindings.session,
        memory: bindings.memory,
        tasks: bindings.taskStore,
        narrative: bindings.narrative,
        compactor: contextCompactor,
      }),
      new TurnToolsBuilder({
        session: bindings.session,
        tools: bindings.tools,
        permission: bindings.permission,
        llm: bindings.llm,
        narrative: bindings.narrative,
        getCommandRunner: bindings.getCommandRunner,
        buildAsk: bindings.buildAskForTurn,
        askUserInteraction: bindings.askUserRegistry,
        skillRunner: bindings.skillRunner,
        knowledgeSearch: bindings.kbSearch,
        getSessionToolResultStore: bindings.getSessionToolResultStore,
        agentRunStore: bindings.agentRunStore,
        agentRunTranscriptWriter: bindings.agentRunTranscript,
        taskStore: bindings.taskStore,
        toolExecutionJournal: bindings.toolExecutionJournal,
        backgroundProcesses: bindings.backgroundProcesses,
      }),
    ),
  );

  return { executor, inputPreparer };
}
