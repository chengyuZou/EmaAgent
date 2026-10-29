import { randomUUID } from 'node:crypto';
import type { VisionDescriptionCache } from '@ema-agent/attachments';
import {
  compactManualMinRatioSetting,
  readCompactSettings,
  type CompactEvent,
  type CompactRequest,
  type CompactResult,
} from '@ema-agent/compact';
import {
  projectMessages,
  prepareMediaMessages,
  readMediaSettings,
  buildPromptMessages,
  type DescribeImage,
} from '@ema-agent/context';
import {
  type CompleteLLM,
  type LLMConnection,
  type Message,
} from '@ema-agent/llm';
import type { ProviderModels, Providers } from '@ema-agent/providers';
import { staticSystemPrompt, getDynamicSystemPrompt } from '@ema-agent/prompts';
import {
  SessionBusyError,
  type SessionRunningRegistry,
  type Session,
  type SessionStore,
} from '@ema-agent/session';
import type { SettingsStore } from '@ema-agent/settings';
import { renderSkillListing, type SkillDescriptor } from '@ema-agent/skills';
import { estimateMessagesTokens } from '@ema-agent/token';
import {
  createTurnHistoryResolver,
  resolveSkillPool,
  type TurnStore,
} from '@ema-agent/turn';
import type { UsageRecorder } from '@ema-agent/usage';
import { CommandsError } from '../errors.js';

export type ManualCompactResult =
  | {
      readonly status: 'completed';
      /** 本次实际用于压缩的模型窗口;前端据此更新压缩后的 Context Meter. */
      readonly contextWindow: number;
      readonly beforeTokens: number;
      readonly afterTokens: number;
      readonly savedTokens: number;
      readonly durationMs: number;
    }
  | { readonly status: 'cancelled' };

export interface ManualCompactDeps {
  readonly sessions: Pick<SessionStore,
    'getSessionForWork' | 'listProjectFolders' | 'loadHistory' | 'appendHistorySummary'>;
  /** Assistant 推理块使用所属 Turn 保存的模型来源判断是否可以重放. */
  readonly turns: Pick<TurnStore, 'getTurn'>;
  readonly sessionRunning: SessionRunningRegistry;
  readonly providers: Providers;
  readonly providerModels: ProviderModels;
  readonly settings: SettingsStore;
  /** 与 Turn 共用 CharacterStore 的当前角色与舞台 Presentation. */
  readonly characterPrompt: () => readonly string[];
  /** 与 Turn 同一 Skill 目录来源. */
  readonly skillEntries: (
    cwd: string,
    projectId: string | null,
  ) => Promise<readonly SkillDescriptor[]>;
  /** SkillStore 从 skills.enabled 读取当前禁用路径, 与 Turn 同一来源. */
  readonly disabledSkillPaths: () => readonly string[];
  readonly workspaceInstructions?: (cwd: string) => string | null;
  readonly memoryGuidance?: () => Promise<string | null> | string | null;
  /** 普通图片的 Vision 描述入口; 工具图片不能发送时只占位. */
  readonly describeImage?: DescribeImage;
  /** Vision 描述缓存(path 键, 与 Turn 同一实例); 与 describeImage 同时注入才会生成描述. */
  readonly visionCache?: VisionDescriptionCache;
  readonly createCompact: (
    completeLLM: CompleteLLM,
  ) => (request: CompactRequest) => Promise<CompactResult>;
  readonly createLLMCompletion: (connection: LLMConnection, modelId: string) => CompleteLLM;
  /** 记录每次摘要模型请求的用量, 缺省时不记账. */
  readonly usageRecorder?: UsageRecorder;
  /** 手动压缩生命周期由 Compact 管线生产,这里只提供当前 Session 的传输出口. */
  readonly emit: (event: CompactEvent) => void;
  /** 只有已登记运行的压缩才通知结束, 并且先解除 Session 占用. */
  readonly onFinished: (sessionId: string, status: 'completed' | 'cancelled' | 'failed') => void;
}

export async function compactSession(
  deps: ManualCompactDeps,
  sessionId: string,
): Promise<ManualCompactResult> {
  deps.sessionRunning.assertWorkAllowed(sessionId);
  const session = deps.sessions.getSessionForWork(sessionId);
  if (deps.sessionRunning.isRunning(sessionId)) {
    throw new SessionBusyError(sessionId);
  }
  // 模型解析与下一 Turn 同规则: Session 偏好即下一 Turn 的默认值.
  const providerId = session.providerId;
  const modelId = session.modelId;
  if (!providerId || !modelId) {
    throw new CommandsError(
      'provider/not_configured',
      '未配置模型: Session 未指定 providerId/modelId',
    );
  }
  const providerModel = deps.providerModels.get(providerId, 'llm', modelId);
  if (!providerModel || providerModel.capability !== 'llm') {
    throw new CommandsError(
      'provider/not_configured',
      `模型未在该 Provider 下启用:${providerId} / ${modelId}`,
    );
  }

  const compactId = randomUUID();
  const running = { kind: 'compact', compactId } as const;
  const signal = deps.sessionRunning.register(sessionId, running);
  let status: 'completed' | 'cancelled' | 'failed' = 'failed';
  try {
    const persisted = deps.sessions.loadHistory(sessionId);
    if (persisted.length === 0) {
      throw new CommandsError('nothing_to_compact', '当前会话还没有可压缩的历史');
    }

    const supportsImageInput = providerModel.inputImage === true;
    const historyResolver = createTurnHistoryResolver(deps.turns);
    const historyWithIds = await projectMessages(
      persisted,
      message => message.turnId ? historyResolver.resolveGenerationSource(message.turnId) : undefined,
      {
        supportsImageInput,
        ...(deps.visionCache ? { visionCache: deps.visionCache } : {}),
        ...(deps.describeImage ? { describeImage: deps.describeImage } : {}),
        signal,
      },
    );
    if (historyWithIds.length === 0) {
      throw new CommandsError('nothing_to_compact', '当前会话还没有可压缩的历史');
    }

    const compactSettings = readCompactSettings(deps.settings);
    const history = await prepareMediaMessages(
      historyWithIds.map(entry => entry.message), readMediaSettings(deps.settings), signal,
    );
    // 手动下限只量可压缩的历史本身(System Prompt 是每次请求的固定开销),且先于
    // Prompt 装配判定--会被直接拒绝的命令不该支付 Skill/Memory 的读取.
    const historyTokens = estimateMessagesTokens([...history]);
    const manualMinimum = Math.floor(
      providerModel.contextWindow * deps.settings.get(compactManualMinRatioSetting),
    );
    if (historyTokens < manualMinimum) {
      throw new CommandsError(
        'compact_below_threshold',
        `当前历史估算约 ${historyTokens} tokens,低于手动压缩下限 ${manualMinimum},内容太少无需压缩`,
      );
    }
    // 全部历史都在近期保留线内时 Macro 没有可摘要的旧前缀(retainRatio 与
    // manualMinRatio 的任意组合都可能撞出这个区间),按没有可压内容拒绝.
    const retainTokens = Math.floor(
      providerModel.contextWindow * compactSettings.retainRatio,
    );
    if (historyTokens <= retainTokens) {
      throw new CommandsError(
        'nothing_to_compact',
        '全部历史都在近期保留范围内,没有可摘要的旧前缀',
      );
    }

    const systemMessages = await buildCompactSystemMessages(
      deps,
      session,
      providerId,
      modelId,
    );
    const estimatedInputTokens = estimateMessagesTokens([...systemMessages, ...history]);

    const connection = deps.providers.resolveConnection(providerId, 'llm');
    const completeLLM = deps.createLLMCompletion(connection, modelId);
    const compact = deps.createCompact(completeLLM);

    const result = await compact({
      compactId,
      sessionId,
      providerId,
      modelId,
      usageRecorder: deps.usageRecorder,
      messages: history,
      systemMessages,
      tools: [],
      estimatedInputTokens,
      force: true,
      // 手动压缩需要保存摘要, 而 Micro 只改变内存中的工作消息.
      micro: false,
      contextWindow: providerModel.contextWindow,
      modelMaxOutput: providerModel.maxOutput,
      signal,
      emit: deps.emit,
      settings: compactSettings,
      ...(providerModel.reasoning === true
        ? { thinking: session.reasoningEffort === 'off'
            ? { enabled: false as const }
            : { enabled: true as const, effort: session.reasoningEffort } }
        : {}),
      // Compact 从投影数组开头累计被摘要覆盖的数量, 再映射到最后一条 SQL Message ID.
      // 即使某些 SQL Message 没有模型可见内容, 游标也会覆盖它们所在的旧前缀.
      saveMacroSummary: (summary, summarizedMessageCount, savedTokens) => {
        deps.sessions.appendHistorySummary({
          sessionId,
          turnId: null,
          summary,
          savedTokens,
          summarizedThroughMessageId:
            historyWithIds[summarizedMessageCount - 1]!.messageId,
        });
      },
    });

    if (result.kind === 'macro') {
      status = 'completed';
      return {
        status: 'completed',
        contextWindow: providerModel.contextWindow,
        beforeTokens: result.beforeTokens,
        afterTokens: result.afterTokens,
        savedTokens: result.savedTokens,
        durationMs: result.durationMs,
      };
    }
    // 手动请求禁用了 Micro, 只有 Macro 成功才算完成.
    throw new CommandsError(
      'compact_failed',
      (result.kind === 'unchanged' ? result.failureDetail : undefined) ?? '压缩失败',
    );
  } catch (error) {
    // 取消作为正常终态返回, 运行登记仍由 finally 解除.
    if (signal.aborted) {
      status = 'cancelled';
      return { status };
    }
    throw error;
  } finally {
    deps.sessionRunning.clear(sessionId, running);
    deps.onFinished(sessionId, status);
  }
}

/**
 * 与 Turn 使用同一 Prompt 装配入口, 但读取当前设置和角色.
 * 手动压缩不提供工具, 因此工具说明列表为空.
 */
async function buildCompactSystemMessages(
  deps: ManualCompactDeps,
  session: Session,
  providerId: string,
  modelId: string,
): Promise<readonly Message[]> {
  const cwd = session.cwd ?? '';
  const projectFolderPaths = session.projectId
    ? deps.sessions.listProjectFolders(session.projectId).map(folder => folder.path)
    : [];
  const skillPool = await resolveSkillPool(
    { settings: deps.settings, skillEntries: deps.skillEntries, disabledSkillPaths: deps.disabledSkillPaths },
    cwd,
    session.projectId,
  );
  const blocks = [
    ...staticSystemPrompt,
    ...getDynamicSystemPrompt({
      characterPrompt: deps.characterPrompt,
      permissionMode: session.permissionMode,
      toolNames: [],
      environment: {
        platform: process.platform,
        cwd: cwd || null,
        projectFolderPaths,
        providerId,
        modelId,
      },
      workspaceInstructions: cwd ? deps.workspaceInstructions?.(cwd) ?? null : null,
      memorySection: await deps.memoryGuidance?.() ?? null,
      skillCatalog: skillPool ? renderSkillListing(skillPool) : null,
    }),
  ];
  return buildPromptMessages(blocks).messages;
}
