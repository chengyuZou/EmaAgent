// 集中装配根 Turn 的输入准备、Context、工具与 Agent 执行对象图。

import {
  RootAgentExecution,
  TurnContextBuilder,
  TurnExecutor,
  TurnInputPreparer,
  TurnToolsBuilder,
} from '@ema-agent/turn-execution';
import { agentSetting } from '@ema-agent/agent';
import { contextCompactionSetting } from '@ema-agent/context';
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
    settingsForTurn: () => ({
      agent: bindings.settings.get(agentSetting),
      contextCompaction: bindings.settings.get(contextCompactionSetting),
    }),
  });

  const executor = new TurnExecutor(
    {
      session: bindings.session,
      hooks: bindings.hooks,
      interactions: bindings.interactionQueue,
    },
    new RootAgentExecution(
      {
        transcript: bindings.session,
        hooks: bindings.hooks,
        llm: bindings.llm,
        emotion: bindings.emotion,
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
        agentRunTranscriptWriter: bindings.agentRunTranscript,
        taskStore: bindings.taskStore,
        toolExecutionJournal: bindings.toolExecutionJournal,
      }),
    ),
  );

  return { executor, inputPreparer };
}
