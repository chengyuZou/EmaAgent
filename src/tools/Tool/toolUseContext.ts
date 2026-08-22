// 定义宿主在单次工具调用中提供的业务能力集合。
import type { CommandRunner } from '@ema-agent/sandbox';
import type { TaskStore } from '@ema-agent/tasks';
import type { KnowledgeSearch } from '@ema-agent/knowledge';
import type {
  AddMemoryNote,
  ListMemory,
  ReadMemory,
  SearchMemory,
} from '@ema-agent/memory';
import type { NarrativeSearch } from '@ema-agent/narrative';
import type { SkillPool } from '@ema-agent/skills';
import type { CallVision } from '@ema-agent/vision';
import type { ReadFileState } from '../types.js';
import type { AskUserQuestionSpec } from '../events.js';
import type { BackgroundProcess } from '../background/backgroundProcess.js';

/** 
 * 子 Agent 启动时如何取得父执行上下文。
 * `subagent` 模式下，子agent不继承父agent的上下文，子agent的上下文由宿主提供，子agent的上下文与父agent的上下文是隔离的。
 * `fork` 模式下，子agent继承父agent的上下文，子agent的上下文与父agent的上下文是共享的。
 */
export type SubagentContextMode = 'subagent' | 'fork';

export interface SubagentSpawnOptions {
  providerId?: string;
  modelId?: string;
  /** 任务短描述（3–5 词），展示在 dashboard 与日志；映射自 SubagentTool 的 description 入参。 */
  description?: string;
  contextMode?: SubagentContextMode;
  agentRunId?: string;
  taskId?: string;
  /** AgentRole 目录钉死的角色身份 Prompt（非模型入参）；由 PrepareSubagent 装配进子 Agent 上下文。 */
  systemPrompt?: string;
  /** AgentRole 目录钉死的工具收窄（模型可见名）；PrepareSubagent 只从父 ToolPool 继续收窄，绝不扩权。 */
  disallowedTools?: readonly string[];
}

export interface SubagentRunResult {
  agentRunId: string;
  output: string;
  usage: {
    inputTokens: number;
    outputTokens: number;
  };
}

/**
 * Subagent Tool 消费的子 Agent 启动能力；实现归 agent 包 SubagentSpawner（implements 直赋，无适配层）。
 * 接口站在 tools 包是依赖方向唯一允许的落点：agent → tools（ToolResult/执行器类型）已存在，
 * 反向即环；builtinTools 不依赖 agent。三方法全部必填：子 Agent 的 ToolPool 不含 SubagentTool，
 * 不存在"宿主没有后台通路"的形态——同步等待由 spawnBackground + awaitBackground 限时合成。
 */
export interface SubagentSpawnerFn {
  /** 后台启动并立即返回 agentRunId。 */
  spawnBackground(
    prompt: string,
    options: SubagentSpawnOptions,
    signal: AbortSignal,
  ): string;
  /** 等待后台运行结果；未知 id 返回 null。 */
  awaitBackground(agentRunId: string): Promise<SubagentRunResult | null>;
  /** 取消运行中的子 Agent；未知 id 返回 false。 */
  abortSubagent(agentRunId: string): boolean;
}

/**
 * AskUser 工具向宿主提出的问询解析器：发出结构化问询请求并等待答案。
 * 宿主在 Turn 装配时注入（绑定到该 Turn 的 per-session FIFO 回答通道）。
 *
 * 分层有意如此：Tool 只表达"我要问，给我答案"；事件发射（ask_user_required/
 * ask_user_resolved）、队列排队、超时与取消清卡全是宿主职责——让 Tool 直接 emit
 * 会把 Turn 事件通道与交互队列泄进本上下文，方向反而更差。
 * 问询锚点是 toolCallId——一个交互只可能属于一次 Tool 调用，不再需要独立的 promptId。
 */
export type AskUser = (
  toolCallId: string,
  specs: readonly AskUserQuestionSpec[],
  /** 单调用级取消：Turn abort 与兄弟取消都经它中断等待；用户取消卡片走队列终态。 */
  signal: AbortSignal,
) => Promise<{ answers: Record<string, string> }>;

/**
 * Scratchpad 工具所需的 Turn 级临时存储位置。
 * dir 由宿主按 Turn 隔离，author 标记写入方（主 Agent / 子 Agent）。
 */
export interface Scratchpad {
  readonly dir: string;
  readonly author: string;
}

/**
 * Ema 工具宿主能力全集。
 *
 * 该对象只描述本轮宿主能提供哪些业务能力。Session、Turn、ToolCall 身份和取消
 * 信号属于 ToolInvocation；任何具体 Tool 只能取得 validateContext 返回的窄投影。
 */
export interface ToolUseContext {
  /** 空串表示本次执行没有工作区；文件与 Shell 工具不会进入 ToolPool。 */
  readonly workspaceRoot: string;
  /**
   * 宿主平台,装配时由 process.platform 冻结。
   * 说明书写平台差异文案(Bash 语义、路径写法、信号)只准从这里取,不得自行探测。
  */
  readonly platform: NodeJS.Platform;

  // ── 装配时绑定的执行能力 ──────────────────────────────────────────────────
  /** Bash 工具的受控命令执行器（per-session 缓存）。 */
  readonly commandRunner?: CommandRunner;
  /** Bash 与 Process 工具族共享的持久后台进程入口。 */
  readonly backgroundProcesses?: BackgroundProcess;
  /** KB 检索工具的搜索入口。 */
  readonly knowledgeSearch?: KnowledgeSearch;
  /** Narrative 剧情资料的按需检索入口，仅在 auto 策略下装配。 */
  readonly narrativeSearch?: NarrativeSearch;
  /** Task 工具族的持久存储。 */
  readonly taskStore?: TaskStore;
  /** Subagent 工具的子 Agent 启动器。 */
  readonly subagentSpawner?: SubagentSpawnerFn;
  /** Skill 工具的本根 Turn 冻结技能池;缺省(子 Agent、chat 态)时 Skill 工具不可见。 */
  readonly skillPool?: SkillPool;
  /** Scratchpad 工具的 Turn 级临时存储位置。 */
  readonly scratchpad?: Scratchpad;
  /** File 工具在当前 Turn 内共享的读取状态，用于去重和写入前校验。 */
  readonly readFileState?: ReadFileState;
  /** AskUser 工具的问询解析器。 */
  readonly askUser?: AskUser;
  /** 本 Turn 冻结的 vision 调用（OCR/图注）；缺省时 PdfReadTool 只读文本层。 */
  readonly vision?: CallVision;
  // ── Memory 工具族的四个窄能力（类型由 @ema-agent/memory 导出） ──────────────
  /** MemorySearch 工具的跨两轨关键词搜索能力。 */
  readonly memorySearch?: SearchMemory;
  /** MemoryRead 工具的按相对路径读取正式记忆能力。 */
  readonly memoryRead?: ReadMemory;
  /** MemoryList 工具的列记忆目录能力。 */
  readonly memoryList?: ListMemory;
  /** MemoryNote 工具创建便签的能力（根 Turn 注入，绑定本 Turn 角色）。 */
  readonly memoryNote?: AddMemoryNote;
}
