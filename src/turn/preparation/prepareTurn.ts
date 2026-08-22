// 把根 Turn 的输入规范化并冻结：附件、模型、Prompt、Skill、权限桶与工具层，产出不可变 PreparedTurn。
import path from 'node:path';
import {
  readAgentSettings,
  type AgentBudget,
  type AgentSettings,
  type PrepareSubagent,
} from '@ema-agent/agent';
import {
  AttachmentStore,
  readAttachmentInputSettings,
  resolveAttachmentReferences,
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
  type ContentPart,
  type LlmConnection,
  type Message,
} from '@ema-agent/llm';
import {
  loadPermissionRuleBuckets,
  permissionModeSetting,
  type PermissionMode,
  type PermissionRuleBuckets,
} from '@ema-agent/permission';
import { getSystemPrompt } from '@ema-agent/prompts';
import type { ProviderModels, Providers } from '@ema-agent/providers';
import type {
  AttachmentReferenceBlock,
  MessageBlocks,
  SessionStore,
} from '@ema-agent/session';
import type { SettingsStore } from '@ema-agent/settings';
import {
  builtinSkillsEnabledSetting,
  disabledProjectSourcesSetting,
  disabledSkillKeysSetting,
  freezeSkillPool,
  MAX_SKILL_BYTES,
  readSkillFileBounded,
  renderSkillListing,
  type SkillDescriptor,
  type SkillKey,
  type SkillPool,
} from '@ema-agent/skills';
import type {
  ExecutionProfile,
  RequestDegradationNotice,
  Turn,
} from '@ema-agent/turn-terms';
import { TurnPreparationError } from '../errors.js';
import type { TurnStreamEvent } from '../events.js';
import type { StartTurn } from '../types.js';
import { prepareImagesForModel } from './mediaCompatibility.js';
import {
  prepareTurnTools,
  type TurnToolsAssembly,
  type TurnToolsDeps,
} from './prepareTurnTools.js';

export interface FrozenSelectedSkill {
  readonly key: string;
  readonly callName: string;
  readonly content: string;
}

/** 一个根 Turn 的冻结事实；运行期只读取这一份，不再回读 Settings/Registry/Session。 */
export interface PreparedTurn {
  readonly executionProfile: ExecutionProfile;
  readonly workspaceRoot: string;
  readonly projectId: string | null;
  readonly scratchpadDir?: string;
  readonly callLlm: CallLlm;
  readonly providerId: string;
  readonly modelId: string;
  readonly contextWindow: number;
  /** 模型单次输出上限（null = 未知，仅按预算裁剪）。 */
  readonly maxOutput: number | null;
  readonly supportsImageInput: boolean;
  readonly thinkingEnabled: boolean;
  readonly systemPrompt: readonly string[];
  /** 持久化用的用户消息块（附件为 attachment_ref，原始二进制写占位）。 */
  readonly userMessageBlocks: MessageBlocks;
  /** 首次模型调用看到的用户内容（附件已解析、原始图片已按能力降级）。 */
  readonly userMessageParts: readonly ContentPart[];
  readonly skillPool?: SkillPool;
  readonly selectedSkills: readonly FrozenSelectedSkill[];
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
  /** SkillRegistry 当前全量条目；冻结在 Pool 之前读取一次。 */
  readonly skillEntries: () => readonly SkillDescriptor[];
  /** 默认 llm 包的 createLlmCall；测试注入脚本化调用。 */
  readonly createLlmCall?: (connection: LlmConnection, modelId: string) => CallLlm;
  /** 工作区指令（EMA.md/CLAUDE.md）按本 Turn 的工作区读取；无工作区时不会调用。 */
  readonly workspaceInstructions?: (workspaceRoot: string) => string | null;
  /** 模型不支持图片时的 Vision 描述入口；缺失时原始图片将准备失败而非试探透传。 */
  readonly describeImage?: DescribeAttachmentImage;
  readonly describeRawImage?: (image: Extract<ContentPart, { type: 'image_data' }>) => Promise<string>;
  readonly scratchpadDirForTurn?: (sessionId: string, turnId: string) => string;
  /** 正式构建 false；只有显式开发入口可为 true。 */
  readonly isBypassPermissionsModeAvailable?: boolean;
}

export interface PrepareTurnInput {
  readonly start: StartTurn;
  readonly turn: Turn;
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
  const { start, turn, signal } = input;

  // 设置在任何附件写入或媒体降级前读取一次，确保同一根 Turn 不混用新旧上限。
  const agentSettings = readAgentSettings(deps.settings);
  const compactSettings = readCompactSettings(deps.settings);
  const attachmentSettings = readAttachmentInputSettings(deps.settings);
  const permissionMode = deps.settings.get(permissionModeSetting);

  const session = deps.sessions.getSession(start.sessionId);
  const workspaceRoot = session.workspaceRoot ?? '';
  const projectId = session.projectId;

  const providerId = start.providerId ?? session.providerId;
  const modelId = start.modelId ?? session.modelId;
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
  const callLlm = (deps.createLlmCall ?? createLlmCall)(
    deps.providers.resolveConnection(providerId, 'llm'),
    modelId,
  );
  const supportsImageInput = modelFacts.inputImage === true;
  const degradations: RequestDegradationNotice[] = [];

  // 附件先登记落库；任何一步失败即准备失败，不进入后续装配。
  let storedAttachments: readonly Attachment[] = [];
  try {
    storedAttachments = start.attachments?.length
      ? await deps.attachments.addAll(
          [...start.attachments],
          turn.id,
          turn.sessionId,
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

  const rawParts: ContentPart[] = [
    ...(start.userInput?.trim()
      ? [{ type: 'text' as const, text: start.userInput }]
      : []),
    ...(start.contentParts ?? []),
  ];
  const userMessageBlocks = buildPersistedUserBlocks(rawParts, storedAttachments);

  const attachmentsById = new Map(storedAttachments.map(a => [a.id, a]));
  const refBlocks: AttachmentReferenceBlock[] = storedAttachments.map(a => ({
    type: 'attachment_ref',
    attachmentId: a.id,
    name: a.name,
    mimeType: a.mimeType,
  }));
  const resolvedAttachmentParts: ContentPart[] = refBlocks.length
    ? await resolveAttachmentReferences(refBlocks, attachmentsById, {
        supportsImageInput,
        ...(deps.describeImage ? { describeImage: deps.describeImage } : {}),
        signal,
      }) as ContentPart[]
    : [];
  if (!supportsImageInput && storedAttachments.some(a => a.kind === 'image')) {
    degradations.push({
      attempt: 1,
      reason: '当前 LLM 不支持图片输入，附件图片已转换为文本',
      removed: ['image'],
      replacements: ['description'],
    });
  }

  // 原始图片（非附件）降级：没有描述入口时明确失败，不试探性透传。
  let userMessageParts: ContentPart[] = [...resolvedAttachmentParts, ...rawParts];
  const hasRawImages = userMessageParts.some(
    part => part.type === 'image_data' || part.type === 'image_url',
  );
  if (!supportsImageInput && hasRawImages) {
    if (!deps.describeRawImage) {
      throw new TurnPreparationError(
        'provider/model_capability_unsupported',
        '当前模型不支持图片输入，且没有可用的 Vision 描述入口',
      );
    }
    const prepared = await prepareImagesForModel(userMessageParts, false, {
      describeImage: deps.describeRawImage,
    });
    userMessageParts = [...prepared.parts];
    if (prepared.degradation) degradations.push(prepared.degradation);
  }

  // Skill 目录与 Pool 同步冻结；chat 态不建 Pool（Skill 工具不可见）。
  const skillEntries = start.executionProfile === 'work'
    ? deps.skillEntries()
    : [];
  const skillPool = skillEntries.length
    ? freezeSkillPool({
        entries: skillEntries,
        disabledKeys: deps.settings.get(disabledSkillKeysSetting),
        disabledProjectSources: deps.settings.get(disabledProjectSourcesSetting).disabledSourceIds,
        builtinEnabled: deps.settings.get(builtinSkillsEnabledSetting),
      })
    : undefined;

  const selectedSkills: FrozenSelectedSkill[] = [];
  for (const key of start.selectedSkillKeys ?? []) {
    const descriptor = skillPool?.getByKey(key as SkillKey);
    if (!descriptor) {
      throw new TurnPreparationError(
        'turn/setup_failed',
        `选择的 Skill 不存在或已被禁用：${key}`,
      );
    }
    const content = await readSkillFileBounded(
      path.join(descriptor.rootPath, 'SKILL.md'),
      MAX_SKILL_BYTES,
    );
    selectedSkills.push({ key, callName: descriptor.callName, content });
  }

  const scratchpadDir = start.executionProfile === 'work'
    ? deps.scratchpadDirForTurn?.(turn.sessionId, turn.id)
    : undefined;

  const permissionBuckets = loadPermissionRuleBuckets(
    deps.settings,
    turn.sessionId,
    projectId ?? undefined,
  );

  const tools = prepareTurnTools(deps, {
    sessionId: turn.sessionId,
    turnId: turn.id,
    executionProfile: start.executionProfile,
    narrativePolicy: start.narrativePolicy,
    workspaceRoot,
    ...(scratchpadDir ? { scratchpadDir } : {}),
    ...(skillPool ? { skillPool } : {}),
    kbAssetIds: start.kbAssetIds,
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

  const systemPrompt = getSystemPrompt({
    characterPrompt: deps.characterPrompt,
    executionProfile: start.executionProfile,
    toolNames: tools.toolPool.tools.map(tool => tool.name),
    environment: {
      platform: process.platform,
      workspaceRoot: workspaceRoot || null,
      providerId,
      modelId,
    },
    workspaceInstructions: workspaceRoot ? (deps.workspaceInstructions?.(workspaceRoot) ?? null) : null,
    skillCatalog: skillPool ? renderSkillListing(skillPool) : null,
    // MCP server instructions 尚无生产者（MCP 包未存 InitializeResult instructions），到位后恢复。
    mcpInstructions: null,
  });

  return Object.freeze({
    executionProfile: start.executionProfile,
    workspaceRoot,
    projectId,
    ...(scratchpadDir ? { scratchpadDir } : {}),
    callLlm,
    providerId,
    modelId,
    contextWindow: modelFacts.contextWindow,
    maxOutput: modelFacts.maxOutput,
    supportsImageInput,
    thinkingEnabled: start.thinkingEnabled ?? false,
    systemPrompt,
    userMessageBlocks,
    userMessageParts: Object.freeze(userMessageParts),
    ...(skillPool ? { skillPool } : {}),
    selectedSkills: Object.freeze(selectedSkills),
    agentSettings,
    compactSettings,
    permissionMode,
    tools,
    degradations: Object.freeze(degradations),
    maxIterations: start.executionProfile === 'chat'
      ? agentSettings.chatMaxIterations
      : agentSettings.workMaxIterations,
  });
}

/** 持久化用户消息：文本与透明块原样、附件走 attachment_ref、原始二进制写占位。 */
function buildPersistedUserBlocks(
  parts: readonly ContentPart[],
  attachments: readonly Attachment[],
): MessageBlocks {
  const blocks: Array<ContentPart | AttachmentReferenceBlock> = [];
  for (const part of parts) {
    if (
      part.type === 'image_data'
      || part.type === 'audio_data'
      || part.type === 'file_data'
    ) {
      blocks.push({ type: 'text', text: `[本轮${mediaLabel(part.type)}正文未写入会话数据库]` });
      continue;
    }
    blocks.push(part);
  }
  for (const attachment of attachments) {
    blocks.push({
      type: 'attachment_ref',
      attachmentId: attachment.id,
      name: attachment.name,
      mimeType: attachment.mimeType,
    });
  }
  if (blocks.length === 1 && blocks[0]?.type === 'text') {
    return (blocks[0] as { type: 'text'; text: string }).text;
  }
  return blocks;
}

function mediaLabel(type: 'image_data' | 'audio_data' | 'file_data'): string {
  if (type === 'image_data') return '图片';
  if (type === 'audio_data') return '音频';
  return '文件';
}
