// 把根 Turn 的输入规范化并冻结：附件、模型、Prompt、Skill、权限桶与工具层，产出不可变 PreparedTurn。
import {
  readAgentSettings,
  type AgentBudget,
  type AgentSettings,
  type PrepareSubagent,
} from '@ema-agent/agent';
import {
  AttachmentStore,
  readAttachmentInputSettings,
  type Attachment,
  type DescribeAttachmentImage,
} from '@ema-agent/attachments';
import {
  readCompactSettings,
  type CompactSettings,
} from '@ema-agent/compact';
import {
  createLlmCall,
  type CallLlm,
  type LlmConnection,
  type LlmProtocol,
  type LlmThinking,
  type Message,
} from '@ema-agent/llm';
import {
  loadPermissionRuleBuckets,
  permissionModeSetting,
  type PermissionMode,
  type PermissionRuleBuckets,
} from '@ema-agent/permission';
import type { PromptBlock } from '@ema-agent/prompts';
import type { ProviderModels, Providers } from '@ema-agent/providers';
import type {
  MessageBlocks,
  SessionStore,
  UserBlock as SessionUserBlock,
} from '@ema-agent/session';
import type { SettingsStore } from '@ema-agent/settings';
import type {
  SkillDescriptor,
  SkillKey,
  SkillPool,
} from '@ema-agent/skills';
import type { ExecutionProfile } from '@ema-agent/session';
import type { RequestDegradationNotice } from '../types.js';
import { TurnPreparationError } from '../errors.js';
import type { TurnStreamEvent } from '../events.js';
import type { StartTurn, TurnInputPart } from '../types.js';
import {
  prepareTurnTools,
  type TurnToolsAssembly,
  type TurnToolsDeps,
} from './prepareTurnTools.js';
import {
  buildSessionSystemPrompt,
  resolveWorkSkillPool,
} from './sessionSystemPrompt.js';

/** 一个根 Turn 的冻结事实；运行期只读取这一份，不再回读 Settings/Registry/Session。 */
export interface PreparedTurn {
  readonly executionProfile: ExecutionProfile;
  readonly workspaceRoot: string;
  readonly projectId: string | null;
  readonly scratchpadDir?: string;
  readonly callLlm: CallLlm;
  readonly providerId: string;
  readonly modelId: string;
  /** prepare 解析出的实际调用协议（resolveConnection().protocol 冻结，与模型身份同时回填 Turn）。 */
  readonly protocol: LlmProtocol;
  readonly contextWindow: number;
  /** 模型单次输出上限（null = 未知，仅按预算裁剪）。 */
  readonly maxOutput: number | null;
  readonly supportsImageInput: boolean;
  /** 开启 thinking 时冻结的中立推理配置（enabled + effort），协议 Adapter 各自映射。 */
  readonly thinking?: LlmThinking;
  readonly systemPrompt: readonly PromptBlock[];
  /** 持久化用的用户消息块；附件只保存 attachment_ref。 */
  readonly userMessageBlocks: MessageBlocks;
  readonly skillPool?: SkillPool;
  readonly agentSettings: AgentSettings;
  readonly compactSettings: CompactSettings;
  readonly permissionMode: PermissionMode;
  readonly tools: TurnToolsAssembly;
  readonly degradations: readonly RequestDegradationNotice[];
  readonly maxIterations: number;
}

export interface PrepareTurnDeps extends TurnToolsDeps {
  readonly sessions: Pick<SessionStore, 'getSession'>;
  readonly providers: Providers;
  readonly providerModels: ProviderModels;
  readonly attachments: AttachmentStore;
  readonly characterPrompt: () => readonly string[];
  /** SkillRegistry 当前全量条目（含本 Turn 工作区的 project 技能）；冻结在 Pool 之前读取一次。 */
  readonly skillEntries: (workspaceRoot: string) => Promise<readonly SkillDescriptor[]>;
  /** 默认 llm 包的 createLlmCall；测试注入脚本化调用。 */
  readonly createLlmCall?: (connection: LlmConnection, modelId: string) => CallLlm;
  /** 工作区指令（EMA.md/CLAUDE.md）按本 Turn 的工作区读取；无工作区时不会调用。 */
  readonly workspaceInstructions?: (workspaceRoot: string) => string | null;
  /** 记忆使用指引（静态模板文本，memory 包 buildMemoryGuidance 产出）；两轨摘要不在这里，进 reminder。 */
  readonly memoryGuidance?: () => Promise<string | null> | string | null;
  /** 模型不支持图片时的 Vision 描述入口。 */
  readonly describeImage?: DescribeAttachmentImage;
  readonly scratchpadDirForTurn?: (sessionId: string, turnId: string) => string;
  /** 正式构建 false；只有显式开发入口可为 true。 */
  readonly isBypassPermissionsModeAvailable?: boolean;
}

export interface PrepareTurnInput {
  readonly request: StartTurn;
  /** TurnStore 已创建的根 Turn 身份；Session 身份只取 request.sessionId。 */
  readonly turnId: string;
  readonly budget: AgentBudget;
  readonly prepareSubagent: PrepareSubagent;
  readonly parentMessages: Message[];
  /** 事件出口由 turn.ts 绑定到本 Turn 的事件通道（每 Turn 一个）。 */
  readonly emit: (event: TurnStreamEvent) => void;
  readonly signal: AbortSignal;
}

export async function prepareTurn(
  deps: PrepareTurnDeps,
  input: PrepareTurnInput,
): Promise<PreparedTurn> {
  const { request, turnId, signal } = input;

  // 设置在任何附件写入或媒体降级前读取一次，确保同一根 Turn 不混用新旧上限。
  const agentSettings = readAgentSettings(deps.settings);
  const compactSettings = readCompactSettings(deps.settings);
  const attachmentSettings = readAttachmentInputSettings(deps.settings);
  const permissionMode = deps.settings.get(permissionModeSetting);

  const session = deps.sessions.getSession(request.sessionId);
  const workspaceRoot = session.workspaceRoot ?? '';
  const projectId = session.projectId;

  const providerId = request.modelSelection?.providerId ?? session.providerId;
  const modelId = request.modelSelection?.modelId ?? session.modelId;
  if (!providerId || !modelId) {
    throw new TurnPreparationError(
      'provider/not_configured',
      '未配置模型：请求与 Session 偏好均未指定 providerId/modelId',
    );
  }
  const modelFacts = deps.providerModels.get(providerId, 'llm', modelId);
  if (!modelFacts || modelFacts.capability !== 'llm') {
    throw new TurnPreparationError(
      'provider/not_configured',
      `模型未在该 Provider 下启用：${providerId} / ${modelId}`,
    );
  }
  const connection = deps.providers.resolveConnection(providerId, 'llm');
  const callLlm = (deps.createLlmCall ?? createLlmCall)(connection, modelId);
  const supportsImageInput = modelFacts.inputImage === true;
  const degradations: RequestDegradationNotice[] = [];

  // Skill 目录与 Pool 同步冻结（与 /compact Command 共用同一装配）；chat 态不建 Pool。
  const skillPool = await resolveWorkSkillPool(
    { settings: deps.settings, skillEntries: deps.skillEntries },
    request.executionProfile,
    workspaceRoot,
  );

  // Skill 引用先于附件登记完成解析，避免无效 Skill 让本 Turn 留下孤立附件记录。
  const selectedSkills = resolveSelectedSkills(request.input, skillPool);

  const attachmentInputs = request.input
    .filter((part): part is Extract<TurnInputPart, { type: 'attachment' }> => (
      part.type === 'attachment'
    ))
    .map(part => part.attachment);

  // AttachmentStore 保持输入顺序；后续按同一游标把引用放回原始文本位置。
  let storedAttachments: readonly Attachment[] = [];
  try {
    storedAttachments = attachmentInputs.length
      ? await deps.attachments.addAll(
          attachmentInputs,
          turnId,
          request.sessionId,
          attachmentSettings,
        )
      : [];
  } catch (error) {
    throw new TurnPreparationError(
      'turn/attachment_failed',
      error instanceof Error ? error.message : String(error),
      { cause: error },
    );
  }
  if (!supportsImageInput && storedAttachments.some(a => a.kind === 'image')) {
    degradations.push({
      attempt: 1,
      reason: '当前 LLM 不支持图片输入，附件图片已转换为文本',
      removed: ['image'],
      replacements: ['description'],
    });
  }

  const userMessageBlocks = prepareOrderedInput(
    request.input,
    storedAttachments,
    selectedSkills,
  );

  const scratchpadDir = request.executionProfile === 'work'
    ? deps.scratchpadDirForTurn?.(request.sessionId, turnId)
    : undefined;

  const permissionBuckets = loadPermissionRuleBuckets(
    deps.settings,
    request.sessionId,
    projectId ?? undefined,
  );

  const tools = prepareTurnTools(deps, {
    sessionId: request.sessionId,
    turnId,
    executionProfile: request.executionProfile,
    narrativePolicy: request.narrativePolicy,
    workspaceRoot,
    ...(scratchpadDir ? { scratchpadDir } : {}),
    ...(skillPool ? { skillPool } : {}),
    ...(request.knowledge ? { knowledge: request.knowledge } : {}),
    budget: input.budget,
    prepareSubagent: input.prepareSubagent,
    parentMessages: input.parentMessages,
    model: { providerId, modelId },
    emit: input.emit,
    permission: {
      mode: permissionMode,
      buckets: permissionBuckets,
      isBypassPermissionsModeAvailable:
        deps.isBypassPermissionsModeAvailable ?? false,
    },
    signal,
  });

  const systemPrompt = await buildSessionSystemPrompt(
    {
      characterPrompt: deps.characterPrompt,
      ...(deps.workspaceInstructions
        ? { workspaceInstructions: deps.workspaceInstructions }
        : {}),
      ...(deps.memoryGuidance ? { memoryGuidance: deps.memoryGuidance } : {}),
    },
    {
      executionProfile: request.executionProfile,
      workspaceRoot,
      providerId,
      modelId,
      toolNames: tools.toolPool.tools.map(tool => tool.name),
      ...(skillPool ? { skillPool } : {}),
    },
  );

  return Object.freeze({
    executionProfile: request.executionProfile,
    workspaceRoot,
    projectId,
    ...(scratchpadDir ? { scratchpadDir } : {}),
    callLlm,
    providerId,
    modelId,
    protocol: connection.protocol,
    contextWindow: modelFacts.contextWindow,
    maxOutput: modelFacts.maxOutput,
    supportsImageInput,
    ...(request.modelSelection?.thinkingEnabled
      ? { thinking: { enabled: true as const, effort: request.modelSelection.thinkingEffort } }
      : {}),
    systemPrompt,
    userMessageBlocks,
    ...(skillPool ? { skillPool } : {}),
    agentSettings,
    compactSettings,
    permissionMode,
    tools,
    degradations: Object.freeze(degradations),
    maxIterations: request.executionProfile === 'chat'
      ? agentSettings.chatMaxIterations
      : agentSettings.workMaxIterations,
  });
}

/** 把输入数组逐项映射为同序的 Session 块；模型内容统一从该持久形态派生。 */
function prepareOrderedInput(
  input: readonly TurnInputPart[],
  storedAttachments: readonly Attachment[],
  selectedSkills: ReadonlyMap<string, SkillDescriptor>,
): MessageBlocks {
  const sessionBlocks: SessionUserBlock[] = [];
  let attachmentIndex = 0;

  for (const part of input) {
    if (part.type === 'text') {
      if (part.text.length === 0) continue;
      sessionBlocks.push({ type: 'text', text: part.text });
      continue;
    }
    if (part.type === 'attachment') {
      const attachment = storedAttachments[attachmentIndex++];
      if (!attachment) {
        throw new TurnPreparationError('turn/attachment_failed', '附件登记结果缺少对应记录');
      }
      sessionBlocks.push({
        type: 'attachment_ref',
        attachmentId: attachment.id,
        name: attachment.name,
        mimeType: attachment.mimeType,
      });
      continue;
    }

    const descriptor = selectedSkills.get(part.skillKey)!;
    sessionBlocks.push({
      type: 'skill_ref',
      skillKey: descriptor.key,
      name: descriptor.name,
      callName: descriptor.callName,
      rootPath: descriptor.rootPath,
    });
  }

  return sessionBlocks.length === 1
    && sessionBlocks[0]?.type === 'text'
    ? sessionBlocks[0].text
    : sessionBlocks;
}

/** Skill Chip 提交的是稳定 key；准备期解析成当前 Pool 中已经冻结的描述符。 */
function resolveSelectedSkills(
  input: readonly TurnInputPart[],
  skillPool: SkillPool | undefined,
): ReadonlyMap<string, SkillDescriptor> {
  const selected = new Map<string, SkillDescriptor>();
  for (const part of input) {
    if (part.type !== 'skill' || selected.has(part.skillKey)) continue;
    const descriptor = skillPool?.getByKey(part.skillKey as SkillKey);
    if (!descriptor) {
      throw new TurnPreparationError(
        'turn/setup_failed',
        `选择的 Skill 不存在或已被禁用：${part.skillKey}`,
      );
    }
    selected.set(part.skillKey, descriptor);
  }
  return selected;
}
