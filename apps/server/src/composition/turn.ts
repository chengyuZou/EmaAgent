import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { VisionDescriptionCache } from '@ema-agent/attachments';
import { buildCharacterPrompt, type CharacterStore } from '@ema-agent/characters';
import { createCompact } from '@ema-agent/compact';
import { assembleContext, projectMessages, type DescribeImage } from '@ema-agent/context';
import { type LLMTokenUsage } from '@ema-agent/llm';
import { isWitchTrialCharacter } from '@ema-agent/narrative';
import {
  MEMORY_GUIDANCE,
  memoryRootDir,
  memorySummaryFile,
  MEMORY_SUMMARY_TOKENS,
  listMemoryFiles,
  readMemoryFile,
  readMemorySummary,
  readRelationshipMemoryForTurn,
  relationshipMemoryDir,
  searchMemoryFiles,
  workMemoryDir,
} from '@ema-agent/memory';
import { permissionAskTimeoutSetting, type PermissionStreamEvent } from '@ema-agent/permission';
import type { ToolExecutionEvent, ToolUseContext } from '@ema-agent/tools';
import type { SettingsStore } from '@ema-agent/settings';
import { workspaceInstructionFilesSetting } from '@ema-agent/skills';
import type { StageEngine } from '@ema-agent/stage';
import { AttachmentVisionDescriptionCachesRepo  } from '@ema-agent/storage';
import { formatTaskContextReminder } from '@ema-agent/tasks';
import { SubagentExecutor, maxConcurrentSubagentsSetting, type SubagentEvent } from '@ema-agent/agent';
import {
  SessionInteractionQueue,
  SessionContinuationQueue,
  TurnExecutor,
  prepareContextInput,
  createTurnHistoryResolver,
  type ContextInputDeps,
  type RenderTurnReminderInput,
  type SessionContinuationEvent,
  type TurnReminderScope,
} from '@ema-agent/turn';
import type { UsageRecorder } from '@ema-agent/usage';
import { createVisionCall, VisionError, type CallVision, type VisionImageMime } from '@ema-agent/vision';
import { ensureScratchpadDir, scratchpadTurnDir } from '../platform/paths.js';
import type { AppEvent } from '../application/appEvents.js';
import type { DatabaseComposition } from './database.js';
import type { NarrativeComposition } from './narrative.js';
import type { ProvidersComposition } from './providers.js';
import type { ToolsComposition } from './tools.js';
import type { TurnFanout } from '../application/turnFanout.js';

/** 单个文件只取前 32768 个 UTF-16 码元, 不是按字节截断. 工作区指令不改变工具权限. */
const WORKSPACE_INSTRUCTION_MAX_CHARS = 32 * 1024;

export interface TurnComposition {
  readonly estimateContext: (sessionId: string, signal: AbortSignal) => Promise<{
    inputTokens: number;
    contextWindow: number;
    pendingImageCount: number;
  }>;
  readonly turnExecutor: TurnExecutor;
  readonly subagents: SubagentExecutor;
  readonly continuations: SessionContinuationQueue;
  /** Permission/AskUser 回答路由与 Session 首条状态读取的入口. */
  readonly interactionQueue: SessionInteractionQueue;
  /** 模型不支持图片输入时的 Vision 描述链(commands 的手动压缩历史投影同源复用). */
  readonly describeImage: DescribeImage;
  /** Vision 描述缓存(path 键);context 投影直接消费, 生产只在 describeImage 注入时发生. */
  readonly visionCache: VisionDescriptionCache;
  /** 工作区指令读取闭包, commands 与 Turn 共用同一份工作区指令. */
  readonly workspaceInstructions: (cwd: string) => string | null;
}

export interface TurnCompositionDeps {
  readonly captureScreen: NonNullable<ToolUseContext['captureScreen']>;
  readonly computerUse?: ToolUseContext['computerUse'];
  readonly database: DatabaseComposition;
  readonly settings: SettingsStore;
  readonly providers: ProvidersComposition;
  readonly tools: ToolsComposition;
  readonly narrative: NarrativeComposition;
  readonly characters: CharacterStore;
  /** 处理模型输出时提取演出标签, 词汇随当前角色切换. */
  readonly stage: StageEngine;
  /** 应用事件出口. */
  readonly emitAppEvent: (event: AppEvent) => void;
  /** 在 completed 事务内写入 Memory 提取任务, 由 Memory 调度后续执行. */
  readonly onTurnCompletedInTransaction: (turnId: string) => void;
  readonly publishSubagent: (sessionId: string, event: SubagentEvent) => void;
  readonly publishQueuedInput: (sessionId: string, event: SessionContinuationEvent) => void;
  readonly publishInteraction: (event: PermissionStreamEvent | Extract<ToolExecutionEvent, { type: 'ask_user_required' | 'ask_user_resolved' }>) => void;
  readonly fanout: TurnFanout;
}

export function openTurns(deps: TurnCompositionDeps): TurnComposition {
  const {
    database,
    settings,
    providers,
    tools,
    narrative,
    characters,
    stage
  } = deps;
  const { activeDataDir } = database;
  const memoryRoot = memoryRootDir();

  const interactionQueue = new SessionInteractionQueue(
    settings.get(permissionAskTimeoutSetting),
  );
  let turnExecutor!: TurnExecutor;
  let continuations!: SessionContinuationQueue;
  const subagents = new SubagentExecutor({
    assertSessionWorkAllowed: sessionId => database.session.getSessionForWork(sessionId),
    store: database.subagents,
    messageStore: database.subagentMessages,
    maxConcurrent: () => settings.get(maxConcurrentSubagentsSetting),
    publish: deps.publishSubagent,
    onBackgroundCompleted: (sessionId, subagentId, status) => {
      continuations.subagentCompleted(sessionId, subagentId, status);
    },
    onTerminalResultRead: (sessionId, subagentId) => {
      continuations.subagentResultRead(sessionId, subagentId);
    },
    onRunFinished: runId => {
      interactionQueue.cancelForRun(runId);
    },
  });
  continuations = new SessionContinuationQueue({
    sessions: database.session,
    sessionRunning: database.sessionRunning,
    goals: database.goals,
    startTurn: input => turnExecutor.start(input),
    attachTurn: handle => deps.fanout.attach(handle),
    publish: (sessionId, event) => deps.publishQueuedInput(sessionId, event),
  });
  // 超时设置即改即生效(只影响此后新建的条目,已启动条目保留原超时).
  settings.subscribe(({ changedKeys }) => {
    if (changedKeys.includes(permissionAskTimeoutSetting.key)) {
      interactionQueue.setDefaultTimeout(settings.get(permissionAskTimeoutSetting));
    }
  });

  const visionDescriptions = new VisionDescriptionCache(
    new AttachmentVisionDescriptionCachesRepo(database.dataDb.sqlite),
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
      // 绑定存在但能力被禁用/缺 key:降级链缺省,由 prepareTurn 诚实报降级.
      return undefined;
    }
  };
  // Turn 工具面的 vision 闭包(Read 的 PDF 扫描页 OCR 等):无绑定即 undefined(降级纯文本),
  // 模型身份在闭包内冻结,usage 从结果记录.
  const resolveCallVision = (): CallVision | undefined => {
    const selected = resolveVision();
    if (!selected) {
      return undefined;
    }
    return async (request) => {
      const startedAt = Date.now();
      const callId = randomUUID();
      const result = await selected.vision(request).catch(error => {
        const cancelled = request.signal?.aborted === true
          || (error instanceof Error && error.name === 'AbortError');
        let errorCode = 'vision/call_failed';
        if (cancelled) {
          errorCode = 'vision/aborted';
        } else if (error instanceof VisionError) {
          errorCode = error.code;
        }
        recordVisionUsage(
          database.usageRecorder,
          selected.providerId,
          selected.modelId,
          callId,
          startedAt,
          cancelled ? 'cancelled' : 'failed',
          undefined,
          errorCode
        );
        throw error;
      });
      recordVisionUsage(
        database.usageRecorder,
        selected.providerId,
        selected.modelId,
        callId,
        startedAt,
        'completed',
        result.usage,
        null
      );
      return result;
    };
  };

  const describeImage: DescribeImage = async (image, signal) => {
    const vision = resolveCallVision();
    if (!vision) throw new Error('未配置 vision 模型绑定, 无法描述图片');
    const result = await vision({
      images: [image.type === 'image_data'
        ? { kind: 'base64', data: image.data, mimeType: image.mimeType as VisionImageMime }
        : { kind: 'url', url: image.url }],
      task: 'caption',
      signal,
    });
    return result.text;
  };

  // Reminder 每个 Turn 读取一次, 包含 currentDate, 读取完成后随消息保存.
  const readTurnReminder = async (scope: TurnReminderScope): Promise<RenderTurnReminderInput> => {
    const summaryTokens = MEMORY_SUMMARY_TOKENS;
    const [memoryWork, memoryRelationship] = await Promise.all([
      readMemorySummary(memorySummaryFile(workMemoryDir()), summaryTokens)
        .catch(() => undefined),
      readRelationshipMemoryForTurn(relationshipMemoryDir(), scope.characterName)
        .catch(() => undefined),
    ]);
    // shouldRemind 只检查不消费;提醒随 reminder 落库成功后由 onTaskReminderPersisted 提交 markReminded.
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
      ? `本 Turn scratchpad 已有文件:${scratchpadNames.join(',')}`
      : undefined;
    const subagents = database.subagents.listAllForSession(scope.sessionId);
    return {
      currentDate: new Date().toISOString().slice(0, 10),
      // Memory 读取结束后再读目标, 不把等待期间的旧状态冻结进 reminder.
      goal: database.goals.getCurrent(scope.sessionId),
      subagents,
      ...(memoryWork ? { memoryWork } : {}),
      ...(memoryRelationship ? { memoryRelationship } : {}),
      ...(taskReminder ? { taskReminder } : {}),
      ...(scratchpad ? { scratchpad } : {}),
    };
  };

  const workspaceInstructions = (cwd: string): string | null =>
    readWorkspaceInstructions(cwd, settings.get(workspaceInstructionFilesSetting));

  const contextInputDeps = {
    sessions: database.session,
    providerModels: providers.providerModels,
    settings,
    characterPrompt: () => {
      const character = characters.current();
      return buildCharacterPrompt(character, characters.inspectStagePresentation(character.name));
    },
    skillEntries: (cwd: string, projectId: string | null) => {
      let folderPaths: string[] = [];
      if (projectId) {
        folderPaths = database.session.listProjectFolders(projectId).map((folder) => folder.path);
      } else if (cwd) {
        folderPaths = [cwd];
      }
      return tools.skills.list(folderPaths);
    },
    disabledSkillPaths: () => tools.skillStore.listDisabledPaths(),
    registry: tools.registry,
    workspaceInstructions,
    memoryGuidance: () => MEMORY_GUIDANCE,
  } satisfies ContextInputDeps;

  const estimateContext: TurnComposition['estimateContext'] = async (sessionId, signal) => {
    const prepared = await prepareContextInput(contextInputDeps, sessionId, signal);
    const historyResolver = createTurnHistoryResolver(database.turns);
    let pendingImageCount = 0;
    const history = await projectMessages(
      database.session.loadHistory(sessionId),
      message => message.turnId ? historyResolver.resolveGenerationSource(message.turnId) : undefined,
      {
        supportsImageInput: prepared.modelFacts.inputImage === true,
        imageDescriptionPreview: {
          read: imagePath => visionDescriptions.get(imagePath),
          canDescribe: resolveCallVision() !== undefined,
          onMissing: () => { pendingImageCount += 1; },
        },
        signal,
      },
    );
    signal.throwIfAborted();
    // 投影可能读取附件文件; 等待期间删除的 Session 不再返回旧估算.
    database.session.getSession(sessionId);
    const context = assembleContext({
      systemPrompt: prepared.systemPrompt,
      toolPool: prepared.toolPool,
      messages: history.map(entry => entry.message),
      contextWindow: prepared.modelFacts.contextWindow,
    });
    return {
      inputTokens: context.usage.estimatedInputTokens,
      contextWindow: context.usage.contextWindow,
      pendingImageCount,
    };
  };

  turnExecutor = new TurnExecutor({
    ...contextInputDeps,
    turns: database.turns,
    hasNormalUserMessage: sessionId => database.messages.hasNormalUserMessage(sessionId),
    providers: providers.providers,
    attachments: database.attachments,
    fileStateCache: tools.getSessionFileStateCache,
    interactionQueue,
    publishInteraction: deps.publishInteraction,
    subagents,
    continuations,
    taskStore: database.tasks,
    goalStore: database.goals,
    memorySearch: request => searchMemoryFiles(memoryRoot, request),
    memoryRead: request => readMemoryFile(memoryRoot, request),
    memoryList: request => listMemoryFiles(memoryRoot, request),
    resolveNarrativeSearch: (sessionId, turnId) => {
      // 不改写用户的工具开关. 当前角色不使用游戏剧情时, 本 Turn 不提供查询函数.
      if (!isWitchTrialCharacter(characters.current().name)) {
        return undefined;
      }
      return narrative.resolveSearch(sessionId, turnId);
    },
    backgroundProcesses: tools.backgroundProcesses,
    resolveVision: resolveCallVision,
    captureScreen: deps.captureScreen,
    computerUse: deps.computerUse,
    commandRunner: tools.getCommandRunner,
    toolResultStore: tools.getSessionToolResultStore,
    toolExecutionState: tools.toolExecutionState,
    createCompact,
    describeImage,
    visionCache: visionDescriptions,
    scratchpadDirForTurn: (sessionId, turnId) =>
      ensureScratchpadDir(activeDataDir, sessionId, turnId),
    readTurnReminder,
    // 只有 reminder Message 成功持久化才提交"已提醒",避免 Turn 准备失败吞掉提醒周期.
    onTaskReminderPersisted: sessionId => {
      database.tasks.markReminded(sessionId);
    },
    usageRecorder: database.usageRecorder,
    stage,
    characterName: () => characters.current().name,
    onTurnCompletedInTransaction: deps.onTurnCompletedInTransaction,
  });

  return {
    estimateContext,
    turnExecutor,
    subagents,
    continuations,
    interactionQueue,
    describeImage,
    visionCache: visionDescriptions,
    workspaceInstructions,
  };
}

/** 按用户多选的文件名读取工作区指令,顺序即拼接顺序;全部缺失返回 null. */
function readWorkspaceInstructions(cwd: string, fileNames: readonly string[]): string | null {
  const parts: string[] = [];
  for (const name of fileNames) {
    try {
      const filePath = path.join(cwd, name);
      if (!fs.statSync(filePath).isFile()) continue;
      parts.push(fs.readFileSync(filePath, 'utf8').slice(0, WORKSPACE_INSTRUCTION_MAX_CHARS));
    } catch { /* 读取失败(权限/竞争删除)按无指令处理 */ }
  }
  return parts.length > 0 ? parts.join('\n\n') : null;
}

/** Vision 调用记账; Provider 未返回 usage 时只记延迟与终态, 不补造 Token 数量. */
function recordVisionUsage(
  recorder: UsageRecorder,
  providerId: string,
  modelId: string,
  callId: string,
  startedAt: number,
  status: 'completed' | 'failed' | 'cancelled',
  usage: LLMTokenUsage | undefined,
  errorCode: string | null,
): void {
  recorder.record({
    id: callId,
    sessionId: null,
    turnId: null,
    capability: 'vision',
    providerId,
    modelId,
    status,
    durationMs: Date.now() - startedAt,
    inputTokens: usage?.inputTokens ?? null,
    outputTokens: usage?.outputTokens ?? null,
    cacheReadInputTokens: usage?.cacheReadInputTokens ?? null,
    cacheWriteInputTokens: usage?.cacheWriteInputTokens ?? null,
    quantity: null,
    unit: null,
    errorCode,
    createdAt: startedAt,
  });
}
