// Turn 一族：TurnExecutor 全接线——交互队列、reminder 工厂、Vision 降级、工作区指令。
import fs from 'node:fs';
import path from 'node:path';
import {
  VisionDescriptionCache,
  type DescribeAttachmentImage,
} from '@ema-agent/attachments';
import { buildCharacterPrompt, type CharacterStore } from '@ema-agent/characters';
import { createCompact } from '@ema-agent/compact';
import { gitSummary } from '@ema-agent/git';
import {
  createLlmCall,
  createLlmCompletion,
  type LlmTokenUsage,
} from '@ema-agent/llm';
import {
  buildMemoryGuidance,
  memorySummaryFile,
  readMemoryBudgets,
  readMemorySummary,
  relationshipMemoryDir,
  workMemoryDir,
} from '@ema-agent/memory';
import { prepareNarrativeRecall } from '@ema-agent/narrative';
import { permissionAskTimeoutSetting } from '@ema-agent/permission';
import { DEFAULT_SESSION_TITLE, generateSessionTitle } from '@ema-agent/session';
import type { SettingsStore } from '@ema-agent/settings';
import type { StageEngine } from '@ema-agent/stage';
import { AttachmentVisionDescriptionsRepo } from '@ema-agent/storage';
import { formatTaskContextReminder } from '@ema-agent/tasks';
import {
  SessionInteractionQueue,
  TurnExecutor,
  workspaceInstructionFilesSetting,
  type RenderTurnReminderInput,
  type TurnReminderScope,
} from '@ema-agent/turn';
import { createUsageRecord, reportUsage, type UsageRecorder } from '@ema-agent/usage';
import { createVisionCall, type CallVision, type VisionImageMime } from '@ema-agent/vision';
import { ensureScratchpadDir, scratchpadTurnDir } from '../platform/paths.js';
import type { AppEvent } from '../sse/eventHub.js';
import type { DatabaseComposition } from './database.js';
import type { KnowledgeComposition } from './knowledge.js';
import type { NarrativeComposition } from './narrative.js';
import type { ProvidersComposition } from './providers.js';
import type { ToolsComposition } from './tools.js';

/** 单个指令文件超过 32KB 截断；工作区指令是上下文数据，不是系统权限。 */
const WORKSPACE_INSTRUCTION_MAX_CHARS = 32 * 1024;

export interface TurnComposition {
  readonly turnExecutor: TurnExecutor;
  /** Permission/AskUser 回答路由与 SSE 重连恢复的入口。 */
  readonly interactionQueue: SessionInteractionQueue;
  /** 模型不支持图片输入时的 Vision 描述链（commands 的手动压缩历史投影同源复用）。 */
  readonly describeImage: DescribeAttachmentImage;
  /** 工作区指令读取闭包（commands 装配与下一根 Turn 同字节的 System Prompt 同源复用）。 */
  readonly workspaceInstructions: (workspaceRoot: string) => string | null;
}

export interface TurnCompositionDeps {
  readonly database: DatabaseComposition;
  readonly settings: SettingsStore;
  readonly providers: ProvidersComposition;
  readonly tools: ToolsComposition;
  readonly knowledge: KnowledgeComposition;
  readonly narrative: NarrativeComposition;
  readonly characters: CharacterStore;
  /** 角色舞台：Turn 泵内剥离表现标签；实例由 characters 一族持有（词汇随角色切换）。 */
  readonly stage: StageEngine;
  /** 应用事件出口（eventHub）。 */
  readonly emitAppEvent: (event: AppEvent) => void;
  /** completed 终态事务内的提取入队（Memory 一族）；事务提交后由它自己安排 drain。 */
  readonly onTurnCompletedInTransaction: (turnId: string) => void;
}

export function openTurns(deps: TurnCompositionDeps): TurnComposition {
  const { database, settings, providers, tools, knowledge, narrative, characters, stage } = deps;
  const { activeDataDir } = database;

  const interactionQueue = new SessionInteractionQueue(
    settings.get(permissionAskTimeoutSetting),
  );
  // 超时设置即改即生效（只影响此后新建的条目，在飞条目保留原超时）。
  settings.subscribe(({ changedKeys }) => {
    if (changedKeys.includes(permissionAskTimeoutSetting.key)) {
      interactionQueue.setDefaultTimeout(settings.get(permissionAskTimeoutSetting));
    }
  });

  // ── Vision 降级（模型不支持图片输入时的描述链） ──────────────────────────────
  const visionDescriptions = new VisionDescriptionCache(
    new AttachmentVisionDescriptionsRepo(database.dataDb.sqlite),
  );
  const resolveVision = () => {
    const binding = providers.modelBindings.get('vision');
    if (!binding) return undefined;
    try {
      return {
        providerId: binding.providerId,
        modelId: binding.modelId,
        vision: createVisionCall(providers.providers.resolveConnection(binding.providerId, 'vision'), binding.modelId),
      };
    } catch {
      // 绑定存在但能力被禁用/缺 key：降级链缺省，由 prepareTurn 诚实报降级。
      return undefined;
    }
  };
  const describeImage: DescribeAttachmentImage = (attachment, signal) => {
    const selected = resolveVision();
    if (!selected) return Promise.reject(new Error('未配置 vision 模型绑定，无法描述图片'));
    return visionDescriptions.getOrCreate(
      attachment,
      signal,
      async image => {
        const bytes = await fs.promises.readFile(image.imagePath);
        const startedAt = Date.now();
        // 描述指令用 vision 包内置的 caption 任务文本，不在装配层另写一份。
        const result = await selected.vision({
          images: [{
            kind: 'bytes',
            bytes: new Uint8Array(bytes),
            mimeType: image.mimeType as VisionImageMime,
          }],
          task: 'caption',
          signal,
        });
        recordVisionUsage(database.usageRecorder, selected.providerId, selected.modelId, startedAt, result.usage);
        return result.text;
      },
    );
  };
  // Turn 工具面的 vision 闭包（PdfReadTool 扫描页 OCR 等）：无绑定即 undefined（降级纯文本），
  // 模型身份在闭包内冻结，usage 从结果记录。
  const resolveCallVision = (): CallVision | undefined => {
    const selected = resolveVision();
    if (!selected) return undefined;
    return async (request) => {
      const startedAt = Date.now();
      const result = await selected.vision(request);
      recordVisionUsage(database.usageRecorder, selected.providerId, selected.modelId, startedAt, result.usage);
      return result;
    };
  };

  // ── Reminder 输入（每根 Turn 生产一次；含 currentDate，读取完成即冻结进持久化 reminder） ──
  const readTurnReminder = async (scope: TurnReminderScope): Promise<RenderTurnReminderInput> => {
    const workspaceRoot = database.session.getSession(scope.sessionId).workspaceRoot ?? '';
    const git = scope.executionProfile === 'work' && workspaceRoot
      ? await gitSummary(workspaceRoot).catch(() => undefined)
      : undefined;
    const summaryTokens = readMemoryBudgets(settings).summaryTokens;
    const [memoryWork, memoryRelationship] = await Promise.all([
      readMemorySummary(memorySummaryFile(workMemoryDir()), summaryTokens)
        .catch(() => undefined),
      readMemorySummary(memorySummaryFile(relationshipMemoryDir()), summaryTokens)
        .catch(() => undefined),
    ]);
    const narrativeRecall = scope.narrativePolicy === 'always' && scope.userText.trim().length > 0
      ? await prepareNarrativeRecall(narrative.narrative, {
          sessionId: scope.sessionId,
          turnId: scope.turnId,
          userInput: scope.userText,
          emit: scope.emit,
        }).then(result => result.contextText ?? undefined)
        .catch(() => undefined)
      : undefined;
    // shouldRemind 只检查不消费；提醒随 reminder 落库成功后由 onTaskReminderPersisted 提交 markReminded。
    const pendingTasks = database.tasks.shouldRemind(scope.sessionId)
      ? database.tasks.list(scope.sessionId).filter(
          (task) => task.status === 'pending' || task.status === 'in_progress',
        )
      : [];
    const taskReminder = pendingTasks.length > 0
      ? formatTaskContextReminder(pendingTasks)
      : undefined;
    const scratchpadDir = scratchpadTurnDir(activeDataDir, scope.sessionId, scope.turnId);
    const scratchpadNames = fs.existsSync(scratchpadDir)
      ? fs.readdirSync(scratchpadDir).slice(0, 50)
      : [];
    const scratchpad = scratchpadNames.length > 0
      ? `本 Turn scratchpad 已有文件：${scratchpadNames.join('、')}`
      : undefined;
    return {
      currentDate: new Date().toISOString().slice(0, 10),
      ...(git ? { gitSummary: git } : {}),
      ...(memoryWork ? { memoryWork } : {}),
      ...(memoryRelationship ? { memoryRelationship } : {}),
      ...(narrativeRecall ? { narrativeRecall } : {}),
      ...(taskReminder ? { taskReminder } : {}),
      ...(scratchpad ? { scratchpad } : {}),
    };
  };

  // ── 会话标题：用户消息落库即异步生成；读检/去重/条件写三层各挡一类浪费与覆盖 ──
  const generatingTitles = new Set<string>();
  const startSessionTitleGeneration = (sessionId: string, userText: string): void => {
    // 同 Session 已有一路在生成：并发/连发只调一次模型。
    if (generatingTitles.has(sessionId)) return;
    // 标题已非默认（老会话或用户已改名）：连模型都不调。
    if (database.session.getSession(sessionId).title !== DEFAULT_SESSION_TITLE) return;
    const binding = providers.modelBindings.get('title');
    if (!binding) return;
    const query = userText.trim();
    if (!query) return;

    generatingTitles.add(sessionId);
    void (async () => {
      try {
        const callLlm = createLlmCall(providers.providers.resolveConnection(binding.providerId, 'llm'), binding.modelId);
        const title = await generateSessionTitle(query, async prompt => {
          const completion = await createLlmCompletion(callLlm({
            messages: [{ role: 'user', content: [{ type: 'text', text: prompt }] }],
            maxOutputTokens: 64,
          }));
          const text = completion.blocks
            .filter(block => block.type === 'text')
            .map(block => block.text)
            .join('');
          return text.trim() || undefined;
        });
        if (!title) return;
        // 条件写入是最后防线：生成期间用户改名/会话已删/另一路先完成都不覆盖。
        if (database.session.updateTitleIfDefault(sessionId, title)) {
          deps.emitAppEvent({ type: 'session_title_updated', sessionId, title });
        }
      } catch {
        // 标题是增强体验；失败静默，下一条用户消息会重试。
      } finally {
        generatingTitles.delete(sessionId);
      }
    })();
  };

  const workspaceInstructions = (workspaceRoot: string): string | null =>
    readWorkspaceInstructions(workspaceRoot, settings.get(workspaceInstructionFilesSetting));

  const turnExecutor = new TurnExecutor({
    turns: database.turns,
    sessions: database.session,
    providers: providers.providers,
    providerModels: providers.providerModels,
    settings,
    attachments: database.attachments,
    characterPrompt: () => buildCharacterPrompt(characters.current()),
    skillEntries: (workspaceRoot: string) => tools.skills.list(workspaceRoot || undefined),
    registry: tools.registry,
    interactionQueue,
    agentRunStore: database.agentRuns,
    agentRunMessagesStore: database.agentRunMessages,
    taskStore: database.tasks,
    knowledgeSearch: knowledge.knowledgeSearch,
    narrativeClient: narrative.narrative,
    backgroundProcesses: tools.backgroundProcesses,
    resolveVision: resolveCallVision,
    commandRunner: tools.getCommandRunner,
    toolResultStore: tools.getSessionToolResultStore,
    toolExecutionState: tools.toolExecutionState,
    createCompact,
    workspaceInstructions,
    describeImage,
    scratchpadDirForTurn: (sessionId, turnId) =>
      ensureScratchpadDir(activeDataDir, sessionId, turnId),
    isBypassPermissionsModeAvailable:
      process.env['EMA_BYPASS_PERMISSIONS'] === '1' && process.env.NODE_ENV !== 'production',
    readTurnReminder,
    // 只有 reminder Message 成功持久化才提交"已提醒"，避免 Turn 准备失败吞掉提醒周期。
    onTaskReminderPersisted: sessionId => {
      database.tasks.markReminded(sessionId);
    },
    memoryGuidance: () => buildMemoryGuidance().catch(() => null),
    usageRecorder: database.usageRecorder,
    stage,
    startSessionTitleGeneration,
    characterDirectoryName: () => characters.current().directoryName,
    onTurnCompletedInTransaction: deps.onTurnCompletedInTransaction,
  });

  return { turnExecutor, interactionQueue, describeImage, workspaceInstructions };
}

/** 按用户多选的文件名读取工作区指令，顺序即拼接顺序；全部缺失返回 null。 */
function readWorkspaceInstructions(
  workspaceRoot: string,
  fileNames: readonly string[],
): string | null {
  const parts: string[] = [];
  for (const name of fileNames) {
    try {
      const filePath = path.join(workspaceRoot, name);
      if (!fs.statSync(filePath).isFile()) continue;
      parts.push(fs.readFileSync(filePath, 'utf8').slice(0, WORKSPACE_INSTRUCTION_MAX_CHARS));
    } catch { /* 读取失败（权限/竞争删除）按无指令处理 */ }
  }
  return parts.length > 0 ? parts.join('\n\n') : null;
}

/** Vision 调用记账；Provider 未返回 usage 时只记延迟与状态。 */
function recordVisionUsage(
  recorder: UsageRecorder,
  providerId: string,
  modelId: string,
  startedAt: number,
  usage: LlmTokenUsage | undefined,
): void {
  reportUsage(
    recorder,
    createUsageRecord({
      capability: 'vision',
      providerId,
      modelId,
      status: 'completed',
      startedAt,
      durationMs: Date.now() - startedAt,
      inputTokens: usage?.inputTokens ?? null,
      outputTokens: usage?.outputTokens ?? null,
      cacheReadInputTokens: usage?.cacheReadInputTokens ?? null,
      cacheWriteInputTokens: usage?.cacheWriteInputTokens ?? null,
    }),
    error => console.warn('[usage] Vision 调用记账失败:', error),
  );
}
