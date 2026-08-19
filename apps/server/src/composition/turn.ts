// Turn 一族：TurnExecutor 全接线——交互队列、reminder 工厂、Vision 降级、工作区指令。
import fs from 'node:fs';
import path from 'node:path';
import {
  VisionDescriptionCache,
  type DescribeAttachmentImage,
} from '@ema-agent/attachments';
import { buildCharacterPrompt, type CharacterCardStore } from '@ema-agent/characters';
import { createCompact } from '@ema-agent/compact';
import { gitSummary } from '@ema-agent/git';
import { createLanguageModel, type ContentPart } from '@ema-agent/llm';
import { prepareNarrativeRecall } from '@ema-agent/narrative';
import { permissionAskTimeoutSetting } from '@ema-agent/permission';
import { generateSessionTitle, type UserBlock } from '@ema-agent/session';
import type { SettingsStore } from '@ema-agent/settings';
import { AttachmentVisionDescriptionsRepo } from '@ema-agent/storage';
import { formatTaskContextReminder } from '@ema-agent/tasks';
import {
  SessionInteractionQueue,
  TurnExecutor,
  workspaceInstructionFilesSetting,
  type TurnReminderScope,
} from '@ema-agent/turn';
import type { Turn } from '@ema-agent/turn-terms';
import { createVisionModel, type VisionImageMime } from '@ema-agent/vision';
import { ensureScratchpadDir, scratchpadTurnDir } from '../platform/paths.js';
import type { AppEvent } from '../sse/eventHub.js';
import type { DatabaseComposition } from './database.js';
import type { KnowledgeComposition } from './knowledge.js';
import type { NarrativeComposition } from './narrative.js';
import type { ProvidersComposition } from './providers.js';
import type { ToolsComposition } from './tools.js';

/** 单个指令文件超过 32KB 截断；工作区指令是上下文数据，不是系统权限。 */
const WORKSPACE_INSTRUCTION_MAX_CHARS = 32 * 1024;
/** Vision 降级描述的指令版本：指令文本变化时旧缓存描述失效。 */
const DESCRIBE_INSTRUCTION_REVISION = 'v1';
const DESCRIBE_INSTRUCTION =
  '用中文简要描述这张图片的内容（两三句话），供不支持图片输入的对话模型理解。';

export interface TurnComposition {
  readonly turnExecutor: TurnExecutor;
  /** Permission/AskUser 回答路由与 SSE 重连恢复的入口。 */
  readonly interactionQueue: SessionInteractionQueue;
}

export interface TurnCompositionDeps {
  readonly database: DatabaseComposition;
  readonly settings: SettingsStore;
  readonly providers: ProvidersComposition;
  readonly tools: ToolsComposition;
  readonly knowledge: KnowledgeComposition;
  readonly narrative: NarrativeComposition;
  readonly cards: CharacterCardStore;
  /** 应用事件出口（eventHub）。 */
  readonly emitAppEvent: (event: AppEvent) => void;
}

export function openTurns(deps: TurnCompositionDeps): TurnComposition {
  const { database, settings, providers, tools, knowledge, narrative, cards } = deps;
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
        vision: createVisionModel(providers.providers.resolveConnection(binding.providerId, 'vision')),
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
      {
        providerId: selected.providerId,
        modelId: selected.modelId,
        instructionRevision: DESCRIBE_INSTRUCTION_REVISION,
      },
      signal,
      async image => {
        const bytes = await fs.promises.readFile(image.imagePath);
        const result = await selected.vision.analyze({
          model: selected.modelId,
          images: [{
            kind: 'bytes',
            bytes: new Uint8Array(bytes),
            mimeType: image.mimeType as VisionImageMime,
          }],
          task: 'caption',
          instruction: DESCRIBE_INSTRUCTION,
          signal,
        });
        return result.text;
      },
    );
  };
  const describeRawImage = async (
    image: Extract<ContentPart, { type: 'image_data' }>,
  ): Promise<string> => {
    const selected = resolveVision();
    if (!selected) throw new Error('未配置 vision 模型绑定，无法描述图片');
    const result = await selected.vision.analyze({
      model: selected.modelId,
      images: [{ kind: 'base64', data: image.data, mimeType: image.mimeType as VisionImageMime }],
      task: 'caption',
      instruction: DESCRIBE_INSTRUCTION,
    });
    return result.text;
  };

  // ── Reminder 工厂（每 Turn 一次；git 探测在此 await 并冻结进闭包） ───────────
  const reminderSources = async (scope: TurnReminderScope) => {
    const workspaceRoot = database.session.getSession(scope.sessionId).workspaceRoot ?? '';
    const git = scope.executionProfile === 'work' && workspaceRoot
      ? await gitSummary(workspaceRoot).catch(() => undefined)
      : undefined;
    return {
      ...(git ? { gitSummary: () => git } : {}),
      // Memory 召回槽：Sol 的 Memory 包收口后在此接入。
      ...(scope.narrativePolicy === 'always' && scope.userText.trim().length > 0
        ? {
            narrativeRecall: async () => {
              const result = await prepareNarrativeRecall(narrative.narrative, {
                sessionId: scope.sessionId,
                turnId: scope.turnId,
                userInput: scope.userText,
                emit: scope.emit,
              });
              return result.contextText ?? undefined;
            },
          }
        : {}),
      taskReminder: () => {
        const tasks = database.tasks.takeContextReminder(scope.sessionId);
        return tasks.length > 0 ? formatTaskContextReminder(tasks) : undefined;
      },
      scratchpad: () => {
        const dir = scratchpadTurnDir(activeDataDir, scope.sessionId, scope.turnId);
        if (!fs.existsSync(dir)) return undefined;
        const names = fs.readdirSync(dir).slice(0, 50);
        return names.length > 0 ? `本 Turn scratchpad 已有文件：${names.join('、')}` : undefined;
      },
    };
  };

  // ── Turn 完成后的非关键观察：标题仍是默认值的会话生成标题 ─────────────────────
  const completedObserver = {
    async record(turn: Turn) {
      const session = database.session.getSession(turn.sessionId);
      if (session.title.trim() !== '新对话') return;
      const binding = providers.modelBindings.get('title');
      if (!binding) return;
      const firstUser = database.session
        .loadMessagesForTurn(turn.id)
        .find(message => message.role === 'user');
      const blocks = firstUser?.blocks;
      const query = typeof blocks === 'string'
        ? blocks
        : (blocks ?? [])
            .filter((block): block is Extract<UserBlock, { type: 'text' }> => block.type === 'text')
            .map(block => block.text)
            .join('\n');
      if (!query.trim()) return;

      const llm = createLanguageModel(providers.providers.resolveConnection(binding.providerId, 'llm'));
      const title = await generateSessionTitle(query, async prompt => {
        let text = '';
        for await (const event of llm.stream({
          model: binding.modelId,
          messages: [{ role: 'user', content: [{ type: 'text', text: prompt }] }],
          maxOutputTokens: 64,
        })) {
          if (event.type === 'text_delta') text += event.delta;
        }
        return text.trim() || undefined;
      });
      if (!title) return;
      database.session.updateTitle(turn.sessionId, title);
      deps.emitAppEvent({ type: 'session_title_updated', sessionId: turn.sessionId, title });
    },
  };

  const turnExecutor = new TurnExecutor({
    turns: database.turns,
    sessions: database.session,
    providers: providers.providers,
    providerModels: providers.providerModels,
    settings,
    attachments: database.attachments,
    characterPrompt: () => buildCharacterPrompt(cards.current()),
    skillEntries: () => tools.skills.list(),
    registry: tools.registry,
    decisionQueue: interactionQueue,
    agentRunStore: database.agentRuns,
    agentRunMessagesStore: database.agentRunMessages,
    taskStore: database.tasks,
    knowledgeSearch: knowledge.knowledgeSearch,
    narrativeClient: narrative.narrative,
    backgroundProcesses: tools.backgroundProcesses,
    commandRunner: tools.getCommandRunner,
    toolResultStore: tools.getSessionToolResultStore,
    toolExecutionState: tools.toolExecutionState,
    createCompact,
    workspaceInstructions: workspaceRoot =>
      readWorkspaceInstructions(workspaceRoot, settings.get(workspaceInstructionFilesSetting)),
    describeImage,
    describeRawImage,
    scratchpadDirForTurn: (sessionId, turnId) =>
      ensureScratchpadDir(activeDataDir, sessionId, turnId),
    isBypassPermissionsModeAvailable:
      process.env['EMA_BYPASS_PERMISSIONS'] === '1' && process.env.NODE_ENV !== 'production',
    reminderSources,
    completedObserver,
  });

  return { turnExecutor, interactionQueue };
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
