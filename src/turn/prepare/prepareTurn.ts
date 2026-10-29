import type { SettingsStore } from '@ema-agent/settings';
import type { ToolRegistry } from '@ema-agent/tools';
import {
  readAgentSettings,
  type AgentLoopEvent,
  type PrepareSubagent,
} from '@ema-agent/agent';
import {
  AttachmentStore,
  type VisionDescriptionCache,
} from '@ema-agent/attachments';
import { readMediaSettings, type DescribeImage, type MediaSettings } from '@ema-agent/context';
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
  loadPermissionRules,
} from '@ema-agent/permission';
import {
  type DynamicSystemPromptInput,
  type PromptBlock,
} from '@ema-agent/prompts';
import type { ProviderModels, Providers } from '@ema-agent/providers';
import type {
  MessageBlocks,
  ReasoningEffort,
  SessionStore,
} from '@ema-agent/session';
import {
  type SkillDescriptor,
  type SkillPool,
} from '@ema-agent/skills';
import type { RequestDegradationNotice } from '../types.js';
import type { TurnStreamEvent } from '../events.js';
import type { StartTurn, TurnInputPart } from '../types.js';
import { prepareTurnInputParts } from './turnInputParts.js';
import {
  prepareTurnTools,
  type TurnToolsAssembly,
  type TurnToolsDeps,
} from '../tools/turnTools.js';
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
  /** prepare 解析出的实际调用协议(resolveConnection().protocol 冻结,与模型身份同时回填 Turn). */
  readonly protocol: LLMProtocol;
  readonly contextWindow: number;
  /** 模型单次输出上限(null = 未知,仅按预算裁剪). */
  readonly maxOutput: number | null;
  readonly supportsImageInput: boolean;
  /** 开启 thinking 时冻结的中立推理配置(enabled + effort),协议 Adapter 各自映射. */
  readonly thinking?: LLMThinking;
  /** 本轮已读取的动态输入; 子代理复用数据段, 换成自己的模型和工具, 不传根角色人设. */
  readonly dynamicSystemPromptInput: DynamicSystemPromptInput;
  readonly systemPrompt: readonly PromptBlock[];
  /** 按输入顺序持久化的消息块, 附件保存 image/file/pasted_text_reference. */
  readonly userMessageBlocks: MessageBlocks;
  readonly skillPool?: SkillPool;
  readonly compactSettings: CompactSettings;
  readonly mediaSettings: MediaSettings;
  readonly tools: TurnToolsAssembly;
  readonly degradations: readonly RequestDegradationNotice[];
  readonly maxIterations: number;
}

export interface PrepareTurnDeps extends TurnToolsDeps {
  readonly registry: ToolRegistry;
  readonly settings: SettingsStore;
  readonly sessions: Pick<SessionStore, 'getSession' | 'listProjectFolders'>;
  readonly providers: Providers;
  readonly providerModels: ProviderModels;
  readonly attachments: AttachmentStore;
  readonly characterPrompt: () => readonly string[];
  /** SkillRegistry 当前全量条目(含本 Turn 工作区的 project 技能);冻结在 Pool 之前读取一次. */
  readonly skillEntries: (
    cwd: string,
    projectId: string | null,
  ) => Promise<readonly SkillDescriptor[]>;
  /** SkillStore 从 skills.enabled 读取当前禁用路径, 覆盖 builtin/user. */
  readonly disabledSkillPaths: () => readonly string[];
  /** 缺省时使用 llm 包的 createLLMCall, 测试可注入预先安排好事件的调用函数. */
  readonly createLLMCall?: (connection: LLMConnection, modelId: string) => CallLLM;
  /** 工作区指令(EMA.md/CLAUDE.md)按本 Turn 的工作区读取;无工作区时不会调用. */
  readonly workspaceInstructions?: (cwd: string) => string | null;
  /** 记忆使用指引由 memory 包提供; Work 摘要和角色关系记忆经 reminder 注入. */
  readonly memoryGuidance?: () => Promise<string | null> | string | null;
  /** 模型不支持图片时的 Vision 描述入口. */
  readonly describeImage?: DescribeImage;
  /** Vision 描述缓存(path 键);与 describeImage 同时注入才会现做生产. */
  readonly visionCache?: VisionDescriptionCache;
  readonly scratchpadDirForTurn?: (sessionId: string, turnId: string) => string;
}

export interface PrepareTurnInput {
  readonly request: StartTurn;
  /** TurnStore 已创建的 Turn 身份; Session 身份只取 request.sessionId. */
  readonly turnId: string;
  readonly prepareSubagent: PrepareSubagent;
  /** 事件出口由 turn.ts 绑定到本 Turn 的事件通道(每 Turn 一个). */
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
  if (request.triggerType === 'userMessage'
    && request.input.some(part => part.type === 'text' && part.text.trim().length > 0)) {
    deps.computerUse?.noteUserInput(request.sessionId);
  }

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
      reason: '当前 LLM 不支持图片输入, 附件图片将按可用描述或标签交付',
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

  const permissionRules = loadPermissionRules(
    deps.settings,
    projectId ?? undefined,
  );

  const tools = await prepareTurnTools(deps, {
    toolPool,
    sessionId: request.sessionId,
    turnId,
    cwd,
    workspaceRoots,
    ...(scratchpadDir ? { scratchpadDir } : {}),
    ...(skillPool ? { skillPool } : {}),
    prepareSubagent: input.prepareSubagent,
    reasoningEffort: session.reasoningEffort,
    emit: input.emit,
    ...(input.onSubagentLLMCallFinished
      ? { onSubagentLLMCallFinished: input.onSubagentLLMCallFinished }
      : {}),
    permission: {
      mode: permissionMode,
      rules: permissionRules,
    },
    signal,
  });

  let thinking: LLMThinking | undefined;
  if (modelFacts.reasoning === true) {
    thinking = session.reasoningEffort === 'off'
      ? { enabled: false }
      : { enabled: true, effort: session.reasoningEffort };
  }

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
    ...(thinking ? { thinking } : {}),
    dynamicSystemPromptInput: dynamicInput,
    systemPrompt,
    userMessageBlocks,
    ...(skillPool ? { skillPool } : {}),
    compactSettings,
    mediaSettings: readMediaSettings(deps.settings),
    tools,
    degradations: Object.freeze(degradations),
    maxIterations: agentSettings.maxIterations,
  });
}

