// 手动 /compact：与根 Turn 同坑互斥的确定性历史改写，不创建 Turn。
// 链：坑位(kind='compact') → 读历史 → buildHistoryMessages 投影 → 触发线下限闸 →
// 与下一根 Turn 同事实的 systemMessages → compact(force=true) →
// 游标映射 appendHistorySummary（唯一提交点；abort/失败即历史原样）。
// 命令路径的压缩终态一定是 macro：低于触发线在调用前拒绝，macro 失败按错误上抛，
// 不存在 micro/unchanged 等其他结果形态。
//
// tools 为空——根 Turn 的 ToolPool 装配需要 Turn 身份（SubagentSpawner/scratchpad/
// narrative 事件归因），在 Turn 外伪造身份被禁止，因此历史边界缓存断点在手动路径
// 架构性不可达；能共享的是静态产品段与动态尾到 execution-profile 为止的前缀。
import { randomUUID } from 'node:crypto';
import type { VisionDescriptionCache, VisionDescriptionProducer } from '@ema-agent/attachments';
import {
  compactManualMinRatioSetting,
  readCompactSettings,
  type CompactRequest,
  type CompactResult,
} from '@ema-agent/compact';
import {
  buildHistoryMessages,
  buildPromptMessages,
} from '@ema-agent/context';
import {
  type CallLlm,
  type LlmConnection,
  type Message,
} from '@ema-agent/llm';
import type { ProviderModels, Providers } from '@ema-agent/providers';
import {
  SessionBusyError,
  type ActiveSessionRegistry,
  type Session,
  type SessionStore,
} from '@ema-agent/session';
import type { SettingsStore } from '@ema-agent/settings';
import type { SkillDescriptor } from '@ema-agent/skills';
import { estimateMessagesTokens } from '@ema-agent/token';
import {
  buildSessionSystemPrompt,
  createGenerationTargetResolver,
  resolveWorkSkillPool,
  type TurnStore,
} from '@ema-agent/turn';
import { recordLlmCallUsage, type UsageRecorder } from '@ema-agent/usage';
import { CommandsError } from '../errors.js';

export type CommandCompactResult =
  | {
      readonly status: 'completed';
      /** 本次实际用于压缩的模型窗口；前端据此更新压缩后的 Context Meter。 */
      readonly contextWindow: number;
      readonly beforeTokens: number;
      readonly afterTokens: number;
      readonly savedTokens: number;
      readonly durationMs: number;
      /** 历史超出当前模型窗口被直接丢弃（未摘要）的最旧消息；未发生时缺省。 */
      readonly truncatedMessageCount?: number;
      readonly truncatedTokens?: number;
    }
  | { readonly status: 'cancelled' };

export interface CommandCompactDeps {
  readonly sessions: Pick<SessionStore, 'getSession' | 'loadHistory' | 'appendHistorySummary'>;
  /** Assistant 历史的 generatedBy 解析（createGenerationTargetResolver 的事实源）。 */
  readonly turns: Pick<TurnStore, 'getTurn'>;
  readonly activeSessions: ActiveSessionRegistry;
  readonly providers: Providers;
  readonly providerModels: ProviderModels;
  readonly settings: SettingsStore;
  /** 与根 Turn 共用 CharacterStore 的当前角色与舞台 Presentation。 */
  readonly characterPrompt: () => readonly string[];
  /** 与根 Turn 同一 Skill 目录来源；chat 态不调用。 */
  readonly skillEntries: (workspaceRoot: string) => Promise<readonly SkillDescriptor[]>;
  /** skill_enablement 表的当前禁用路径列表（与根 Turn 同一来源）。 */
  readonly disabledSkillPaths: () => readonly string[];
  readonly workspaceInstructions?: (workspaceRoot: string) => string | null;
  readonly memoryGuidance?: () => Promise<string | null> | string | null;
  /** 模型不支持图片输入时的 Vision 描述入口（与根 Turn 同一条降级链）。 */
  readonly describeImage?: VisionDescriptionProducer;
  /** Vision 描述缓存(path 键,与根 Turn 同一实例);与 describeImage 同时注入才会现做生产。 */
  readonly visionCache?: VisionDescriptionCache;
  readonly createCompact: (
    callLlm: CallLlm,
  ) => (request: CompactRequest) => Promise<CompactResult>;
  /** 默认 llm 包的 createLlmCall；测试注入脚本化调用。 */
  readonly createLlmCall: (connection: LlmConnection, modelId: string) => CallLlm;
  /** 摘要调用记账；缺省不记账（观测不阻断主链）。 */
  readonly usageRecorder?: UsageRecorder;
}

export async function compactSession(
  deps: CommandCompactDeps,
  sessionId: string,
): Promise<CommandCompactResult> {
  if (deps.activeSessions.isRunning(sessionId)) {
    throw new SessionBusyError(sessionId);
  }
  const session = deps.sessions.getSession(sessionId);
  // 模型解析与下一根 Turn 同规则：Session 偏好即下一 Turn 的默认值，缓存共享是向前的。
  const providerId = session.providerId;
  const modelId = session.modelId;
  if (!providerId || !modelId) {
    throw new CommandsError(
      'provider/not_configured',
      '未配置模型：Session 未指定 providerId/modelId',
    );
  }
  const providerModel = deps.providerModels.get(providerId, 'llm', modelId);
  if (!providerModel || providerModel.capability !== 'llm') {
    throw new CommandsError(
      'provider/not_configured',
      `模型未在该 Provider 下启用：${providerId} / ${modelId}`,
    );
  }

  const executionId = randomUUID();
  const signal = deps.activeSessions.register(sessionId, executionId, 'compact');
  try {
    const persisted = deps.sessions.loadHistory(sessionId);
    if (persisted.length === 0) {
      throw new CommandsError('nothing_to_compact', '当前会话还没有可压缩的历史');
    }

    const supportsImageInput = providerModel.inputImage === true;
    const historyWithIds = await buildHistoryMessages(
      persisted,
      createGenerationTargetResolver(deps.turns),
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
    const history = historyWithIds.map(entry => entry.message);
    // 手动下限只量可压缩的历史本身（System Prompt 是每次请求的固定开销），且先于
    // Prompt 装配判定——会被直接拒绝的命令不该支付 Skill/Memory 的读取。
    const historyTokens = estimateMessagesTokens(history);
    const manualMinimum = Math.floor(
      providerModel.contextWindow * deps.settings.get(compactManualMinRatioSetting),
    );
    if (historyTokens < manualMinimum) {
      throw new CommandsError(
        'compact_below_threshold',
        `当前历史估算约 ${historyTokens} tokens，低于手动压缩下限 ${manualMinimum}，内容太少无需压缩`,
      );
    }
    // 全部历史都在近期保留线内时 Macro 没有可摘要的旧前缀（retainRatio 与
    // manualMinRatio 的任意组合都可能撞出这个区间），按没有可压内容拒绝。
    const retainTokens = Math.floor(
      providerModel.contextWindow * compactSettings.retainRatio,
    );
    if (historyTokens <= retainTokens) {
      throw new CommandsError(
        'nothing_to_compact',
        '全部历史都在近期保留范围内，没有可摘要的旧前缀',
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
    const callLlm = deps.createLlmCall(connection, modelId);
    const compact = deps.createCompact(callLlm);

    const result = await compact({
      sessionId,
      executionProfile: session.executionProfile,
      history,
      systemMessages,
      tools: [],
      estimatedInputTokens,
      force: true,
      // 命令路径只要纯粹的 Macro：Micro 的占位替换从不落库，跳过它语义更干净。
      micro: false,
      contextWindow: providerModel.contextWindow,
      modelMaxOutput: providerModel.maxOutput,
      signal,
      settings: compactSettings,
      // 游标映射与根 Turn 同一闭包语义：计数（含窗口截断丢弃偏移）→ 输入历史身份
      // → 覆盖截止游标，被丢弃消息随游标一并退出可见历史。
      saveMacroSummary: (summary, summarizedMessageCount) => {
        deps.sessions.appendHistorySummary({
          sessionId,
          summary,
          summarizedThroughMessageId:
            historyWithIds[summarizedMessageCount - 1]!.sessionMessageId,
        });
      },
    });

    if (result.kind === 'macro') {
      // 摘要调用的 usage 随完成结果带出（收完的 completion 快照）；abort/失败没有
      // completion 自然不记——与 Claude/Codex "只在流完结时入账"同规。
      recordLlmCallUsage(deps.usageRecorder, {
        providerId,
        modelId,
        status: 'completed',
        startedAt: Date.now() - result.durationMs,
        durationMs: result.durationMs,
        usage: result.usage,
        // 手动压缩不铸 turnId/llmCallId；callId 用坑位执行身份，便于对账。
        usageContext: { callId: `compact:${executionId}`, sessionId },
      });
      return {
        status: 'completed',
        contextWindow: providerModel.contextWindow,
        beforeTokens: result.beforeTokens,
        afterTokens: result.afterTokens,
        savedTokens: result.savedTokens,
        durationMs: result.durationMs,
        ...(result.droppedMessageCount > 0
          ? {
              truncatedMessageCount: result.droppedMessageCount,
              truncatedTokens: result.droppedTokens,
            }
          : {}),
      };
    }
    // 命令路径一定是 macro（micro:false）；unchanged 即 macro 失败，micro 形态不可达。
    throw new CommandsError(
      'compact_failed',
      (result.kind === 'unchanged' ? result.failureDetail : undefined) ?? '压缩失败',
    );
  } catch (error) {
    // 摘要落库是唯一提交点：abort 时历史原样，返回取消终态而非错误。
    if (signal.aborted) return { status: 'cancelled' };
    throw error;
  } finally {
    deps.activeSessions.clear(sessionId, executionId);
  }
}

/**
 * 摘要请求的系统段：与根 Turn 共用同一装配（resolveWorkSkillPool +
 * buildSessionSystemPrompt），事实不变时逐字节一致，共享前缀缓存。
 * toolNames 恒空（手动路径不装配 ToolPool，见文件头注释）。
 */
async function buildCompactSystemMessages(
  deps: CommandCompactDeps,
  session: Session,
  providerId: string,
  modelId: string,
): Promise<readonly Message[]> {
  const workspaceRoot = session.workspaceRoot ?? '';
  const skillPool = await resolveWorkSkillPool(
    { settings: deps.settings, skillEntries: deps.skillEntries, disabledSkillPaths: deps.disabledSkillPaths },
    session.executionProfile,
    workspaceRoot,
  );
  const blocks = await buildSessionSystemPrompt(
    {
      characterPrompt: deps.characterPrompt,
      ...(deps.workspaceInstructions
        ? { workspaceInstructions: deps.workspaceInstructions }
        : {}),
      ...(deps.memoryGuidance ? { memoryGuidance: deps.memoryGuidance } : {}),
    },
    {
      executionProfile: session.executionProfile,
      workspaceRoot,
      providerId,
      modelId,
      toolNames: [],
      ...(skillPool ? { skillPool } : {}),
    },
  );
  return buildPromptMessages(blocks).messages;
}
