// 固定本轮使用的附件, 模型, Prompt, Skill, 权限与工具层, 产出 PreparedTurn.
import {
  readAgentSettings,
  type AgentLoopEvent,
  type PrepareSubagent,
} from '@ema-agent/agent';
import {
  AttachmentStore,
  type VisionDescriptionCache,
} from '@ema-agent/attachments';
import type { DescribeImage } from '@ema-agent/context';
import {
  readCompactSettings,
  type CompactSettings,
} from '@ema-agent/compact';
import {
  createLLMCall,
  createLLMCompletion,
  type CallLLM,
  type CompleteLLM,
  type LLMConnection,
  type LLMProtocol,
  type LLMThinking,
} from '@ema-agent/llm';
import {
  loadPermissionRuleBuckets,
} from '@ema-agent/permission';
import {
  type DynamicSystemPromptInput,
  type PromptBlock,
} from '@ema-agent/prompts';
import type { ProviderModels, Providers } from '@ema-agent/providers';
import type {
  AttachmentBlock,
  MessageBlocks,
  ReasoningEffort,
  SessionStore,
  SessionUserBlock,
} from '@ema-agent/session';
import {
  type SkillDescriptor,
  type SkillPool,
} from '@ema-agent/skills';
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
  prepareContextInput,
} from './prepareContextInput.js';

/** 一个 Turn 的冻结事实; 运行期只读取这一份, 不再回读 Settings/Registry/Session. */
export interface PreparedTurn {
  readonly reasoningEffort: ReasoningEffort;
  readonly scratchpadDir?: string;
  readonly callLLM: CallLLM;
  readonly completeLLM: CompleteLLM;
  readonly providerId: string;
  readonly modelId: string;
  /** prepare 解析出的实际调用协议（resolveConnection().protocol 冻结，与模型身份同时回填 Turn）。 */
  readonly protocol: LLMProtocol;
  readonly contextWindow: number;
  /** 模型单次输出上限（null = 未知，仅按预算裁剪）。 */
  readonly maxOutput: number | null;
  readonly supportsImageInput: boolean;
  /** 开启 thinking 时冻结的中立推理配置（enabled + effort），协议 Adapter 各自映射。 */
  readonly thinking?: LLMThinking;
  /** 本轮已读取的动态输入; 子代理复用数据段, 换成自己的模型和工具, 不传根角色人设. */
  readonly DynamicSystemPromptInput: DynamicSystemPromptInput;
  readonly systemPrompt: readonly PromptBlock[];
  /** 持久化用的用户消息块；附件只保存 attachment_ref。 */
  readonly userMessageBlocks: MessageBlocks;
  readonly skillPool?: SkillPool;
  readonly compactSettings: CompactSettings;
  readonly tools: TurnToolsAssembly;
  readonly degradations: readonly RequestDegradationNotice[];
  readonly maxIterations: number;
}

export interface PrepareTurnDeps extends TurnToolsDeps {
  readonly sessions: Pick<SessionStore, 'getSession' | 'listProjectFolders'>;
  readonly providers: Providers;
  readonly providerModels: ProviderModels;
  readonly attachments: AttachmentStore;
  readonly characterPrompt: () => readonly string[];
  /** SkillRegistry 当前全量条目（含本 Turn 工作区的 project 技能）；冻结在 Pool 之前读取一次。 */
  readonly skillEntries: (
    cwd: string,
    projectId: string | null,
  ) => Promise<readonly SkillDescriptor[]>;
  /** SkillStore 从 skills.enabled 读取当前禁用路径, 覆盖 builtin/user. */
  readonly disabledSkillPaths: () => readonly string[];
  /** 缺省时使用 llm 包的 createLLMCall, 测试可注入预先安排好事件的调用函数. */
  readonly createLLMCall?: (connection: LLMConnection, modelId: string) => CallLLM;
  /** 工作区指令（EMA.md/CLAUDE.md）按本 Turn 的工作区读取；无工作区时不会调用。 */
  readonly workspaceInstructions?: (cwd: string) => string | null;
  /** 记忆使用指引由 memory 包提供; Work 摘要和角色关系记忆经 reminder 注入. */
  readonly memoryGuidance?: () => Promise<string | null> | string | null;
  /** 模型不支持图片时的 Vision 描述入口。 */
  readonly describeImage?: DescribeImage;
  /** Vision 描述缓存(path 键);与 describeImage 同时注入才会现做生产。 */
  readonly visionCache?: VisionDescriptionCache;
  readonly scratchpadDirForTurn?: (sessionId: string, turnId: string) => string;
}

export interface PrepareTurnInput {
  readonly request: StartTurn;
  /** TurnStore 已创建的 Turn 身份; Session 身份只取 request.sessionId. */
  readonly turnId: string;
  readonly prepareSubagent: PrepareSubagent;
  /** 事件出口由 turn.ts 绑定到本 Turn 的事件通道（每 Turn 一个）。 */
  readonly emit: (event: TurnStreamEvent) => void;
  readonly onSubagentLLMCallFinished?: (
    event: Extract<AgentLoopEvent, { type: 'llm_call_finished' }>,
  ) => void;
  readonly signal: AbortSignal;
}

export async function prepareTurn(
  deps: PrepareTurnDeps,
  input: PrepareTurnInput,
): Promise<PreparedTurn> {
  const { request, turnId, signal } = input;

  // 设置在任何附件写入或媒体降级前读取一次, 确保同一 Turn 不混用新旧上限.
  const agentSettings = readAgentSettings(deps.settings);
  const compactSettings = readCompactSettings(deps.settings);
  const preparedInput = await prepareContextInput(deps, request.sessionId, signal);
  const {
    session, providerId, modelId, modelFacts, cwd, projectId, workspaceRoots,
    skillPool, toolPool, dynamicInput, systemPrompt,
  } = preparedInput;
  const permissionMode = session.permissionMode;
  const connection = deps.providers.resolveConnection(providerId, 'llm');
  const callLLM = (deps.createLLMCall ?? createLLMCall)(connection, modelId);
  const completeLLM = createLLMCompletion(connection, modelId);
  const supportsImageInput = modelFacts.inputImage === true;
  const degradations: RequestDegradationNotice[] = [];

  const attachmentBlocks = request.input
    .filter((part): part is Extract<TurnInputPart, { type: 'attachment' }> => part.type === 'attachment')
    .map(part => part.block);
  if (!supportsImageInput && attachmentBlocks.some(b => b.type === 'image_reference')) {
    degradations.push({
      attempt: 1,
      reason: '当前 LLM 不支持图片输入，附件图片已转换为文本',
      removed: ['image'],
      replacements: ['description'],
    });
  }

  const userMessageBlocks = await prepareTurnInputParts(
    deps.attachments,
    request.sessionId,
    turnId,
    request.input,
    skillPool,
  );

  const scratchpadDir = deps.scratchpadDirForTurn?.(request.sessionId, turnId);

  const permissionBuckets = loadPermissionRuleBuckets(
    deps.settings,
    request.sessionId,
    projectId ?? undefined,
  );

  const tools = prepareTurnTools(deps, {
    toolPool,
    sessionId: request.sessionId,
    turnId,
    cwd,
    workspaceRoots,
    ...(scratchpadDir ? { scratchpadDir } : {}),
    ...(skillPool ? { skillPool } : {}),
    prepareSubagent: input.prepareSubagent,
    providerId,
    modelId,
    reasoningEffort: session.reasoningEffort,
    emit: input.emit,
    ...(input.onSubagentLLMCallFinished
      ? { onSubagentLLMCallFinished: input.onSubagentLLMCallFinished }
      : {}),
    permission: {
      mode: permissionMode,
      buckets: permissionBuckets,
    },
    signal,
  });

  return Object.freeze({
    reasoningEffort: session.reasoningEffort,
    ...(scratchpadDir ? { scratchpadDir } : {}),
    callLLM,
    completeLLM,
    providerId,
    modelId,
    protocol: connection.protocol,
    contextWindow: modelFacts.contextWindow,
    maxOutput: modelFacts.maxOutput,
    supportsImageInput,
    ...(modelFacts.reasoning === true
      ? { thinking: session.reasoningEffort === 'off'
          ? { enabled: false as const }
          : { enabled: true as const, effort: session.reasoningEffort } }
      : {}),
    DynamicSystemPromptInput: dynamicInput,
    systemPrompt,
    userMessageBlocks,
    ...(skillPool ? { skillPool } : {}),
    compactSettings,
    tools,
    degradations: Object.freeze(degradations),
    maxIterations: agentSettings.maxIterations,
  });
}

/** 把输入数组逐项映射为同序的 Session 块；模型内容统一从该持久形态派生。 */
/**
 * 初始输入和运行中立即引导共用这一条解析链. Skill 必须先确认存在,
 * 然后附件才登记到 Turn, 避免无效 Skill 留下孤立附件记录.
 */
export async function prepareTurnInputParts(
  attachments: AttachmentStore,
  sessionId: string,
  turnId: string,
  input: readonly TurnInputPart[],
  skillPool: SkillPool | undefined,
): Promise<MessageBlocks> {
  const selectedSkills = resolveSelectedSkills(input, skillPool);
  const attachmentBlocks = input
    .filter((part): part is Extract<TurnInputPart, { type: 'attachment' }> => part.type === 'attachment')
    .map(part => part.block);
  let attachedBlocks: readonly AttachmentBlock[] = [];
  try {
    attachedBlocks = attachmentBlocks.length > 0
      ? await attachments.attach(sessionId, turnId, attachmentBlocks)
      : [];
  } catch (error) {
    throw new TurnPreparationError(
      'turn/attachment_failed',
      error instanceof Error ? error.message : String(error),
      { cause: error },
    );
  }
  return prepareOrderedInput(input, attachedBlocks, selectedSkills);
}

function prepareOrderedInput(
  input: readonly TurnInputPart[],
  attachedBlocks: readonly AttachmentBlock[],
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
      const block = attachedBlocks[attachmentIndex++];
      if (!block) {
        throw new TurnPreparationError('turn/attachment_failed', '附件校验结果缺少对应块');
      }
      sessionBlocks.push(block);
      continue;
    }

    const descriptor = selectedSkills.get(part.path)!;
    sessionBlocks.push({
      type: 'skill_reference',
      name: descriptor.name,
      path: descriptor.path,
    });
  }

  return sessionBlocks.length === 1
    && sessionBlocks[0]?.type === 'text'
    ? sessionBlocks[0].text
    : sessionBlocks;
}

/** Skill Chip 提交绝对 SKILL.md path;准备期解析成当前 Pool 中已经冻结的描述符。 */
function resolveSelectedSkills(
  input: readonly TurnInputPart[],
  skillPool: SkillPool | undefined,
): ReadonlyMap<string, SkillDescriptor> {
  const selected = new Map<string, SkillDescriptor>();
  for (const part of input) {
    if (part.type !== 'skill_reference' || selected.has(part.path)) continue;
    const descriptor = skillPool?.getByPath(part.path);
    if (!descriptor) {
      throw new TurnPreparationError(
        'turn/setup_failed',
        `选择的 Skill 不存在或已被禁用：${part.path}`,
      );
    }
    selected.set(part.path, descriptor);
  }
  return selected;
}
