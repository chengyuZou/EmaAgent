// 定义宿主在单次工具调用中提供的业务能力集合。
import type { CommandRunner } from '@ema-agent/sandbox';
import type { TaskStore } from '@ema-agent/tasks';
import type { KnowledgeSearch } from '@ema-agent/knowledge';
import type { NarrativeSearch } from '@ema-agent/narrative';
import type { SkillPool } from '@ema-agent/skills';
import type { VisionModel } from '@ema-agent/vision';
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
  /** 角色注入的 system prompt；由 PrepareSubagent 装配进子 Agent 上下文。 */
  systemPrompt?: string;
  /** 类型级工具收窄（按模型可见工具名匹配）；由 PrepareSubagent 收窄子 ToolPool。 */
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

/** Subagent Tool 消费的子 Agent 启动能力；Agent 提供结构化实现，不被 Tools 反向导入。 */
export interface SubagentSpawnerFn {
  spawn(
    prompt: string,
    options: SubagentSpawnOptions,
    signal: AbortSignal,
  ): Promise<SubagentRunResult>;
  spawnBackground?(
    prompt: string,
    options: SubagentSpawnOptions,
    signal: AbortSignal,
  ): string;
  awaitBackground?(agentRunId: string): Promise<SubagentRunResult | null>;
  abortSubagent?(agentRunId: string): boolean;
}

/**
 * AskUser 工具向宿主提出的问询解析器：发出结构化问询请求并等待答案。
 * 宿主在 Turn 装配时注入（绑定到该 Turn 的 per-session FIFO 回答通道）。
 *
 * 事件发射归宿主实现，不归 Tool：宿主发射 ask_user_required、等待回答后
 * 发射 ask_user_resolved；取消/失败时发射空答案 resolved 清前端卡片并原样抛出。
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
 * 视觉模型选择（来自 model_bindings 的 vision 绑定）：装配层解析 VisionModel 后注入。
 * PdfReadTool 等需要读图的工具在 validateContext 里取它做 OCR/图注描述。
 */
export interface ToolVisionSelection {
  readonly model: string;
  readonly vision: VisionModel;
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
  /** 视觉模型选择（vision 绑定）: PdfReadTool 扫描页 OCR / 图注描述用; 缺省时 PDF 只读文本层。 */
  readonly vision?: ToolVisionSelection;
}
