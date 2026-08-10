// 定义宿主装配给工具系统的业务能力全集。
import type {
  AgentRunId,
  TaskId,
} from '@ema-agent/ids';
import type { CommandRunnerPort } from '@ema-agent/sandbox';
import type { TaskStorePort } from '@ema-agent/tasks';
import type { KnowledgeSearchPort } from '@ema-agent/knowledge';
import type { NarrativeSearchPort } from '@ema-agent/narrative';
import type { SkillPool } from '@ema-agent/skills';
import type { ReadFileState } from '../types.js';
import type { AskUserQuestionSpec } from '../events.js';
import type { BackgroundProcessPort } from '../background/types.js';

/** 子 Agent 启动时如何取得父执行上下文。 */
export type SubagentContextMode = 'subagent' | 'fork';

export interface SubagentSpawnOptions {
  model?: string;
  description?: string;
  kind?: SubagentContextMode;
  agentRunId?: AgentRunId;
  taskId?: TaskId;
}

export interface SubagentRunResult {
  agentRunId: AgentRunId;
  output: string;
  usage: {
    inputTokens: number;
    outputTokens: number;
  };
}

/** Subagent Tool 消费的执行端口；Agent 只需结构化实现，不被 Tools 反向导入。 */
export interface SubagentSpawnerPort {
  spawn(
    prompt: string,
    options: SubagentSpawnOptions,
    signal: AbortSignal,
  ): Promise<SubagentRunResult>;
  spawnBackground?(
    prompt: string,
    options: SubagentSpawnOptions,
    signal: AbortSignal,
  ): AgentRunId;
  awaitBackground?(agentRunId: AgentRunId): Promise<SubagentRunResult | null>;
  abortSubagent?(agentRunId: AgentRunId): boolean;
}

/**
 * AskUser 工具向宿主提出的问询解析器：发出结构化问询请求并等待答案。
 * 宿主在 Turn 装配时注入（绑定到该 Turn 的 per-session FIFO 回答通道）。
 *
 * 事件发射归 port 实现,不归 Tool:port 发射 request(required)、
 * 等待回答后发射 resolveEvent(answers)(resolved);取消/失败时发射
 * resolveEvent({}) 清前端卡片并原样抛出。resolveEvent 由 Tool 提供,
 * 因为 resolved 事件的形状是 Tool 变体专属的(answers/selected/text…)。
 */
export type AskUserPort = (
  promptId: string,
  specs: readonly AskUserQuestionSpec[],
  request: unknown,
  resolveEvent: (answers: Record<string, string>) => unknown,
) => Promise<{ answers: Record<string, string> }>;

/**
 * Scratchpad 工具所需的 Turn 级临时存储位置。
 * dir 由宿主按 Turn 隔离，author 标记写入方（主 Agent / 子 Agent）。
 */
export interface ScratchpadPort {
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
  readonly commandRunner?: CommandRunnerPort;
  /** Bash 与 Process 工具族共享的持久后台进程入口。 */
  readonly backgroundProcesses?: BackgroundProcessPort;
  /** KB 检索工具的搜索入口。 */
  readonly knowledgeSearch?: KnowledgeSearchPort;
  /** Narrative 剧情资料的按需检索入口，仅在 auto 策略下装配。 */
  readonly narrativeSearch?: NarrativeSearchPort;
  /** Task 工具族的持久存储。 */
  readonly taskStore?: TaskStorePort;
  /** Subagent 工具的子 Agent 启动器。 */
  readonly subagentSpawner?: SubagentSpawnerPort;
  /** Skill 工具的本根 Turn 冻结技能池;缺省(子 Agent、chat 态)时 Skill 工具不可见。 */
  readonly skillPool?: SkillPool;
  /** Scratchpad 工具的 Turn 级临时存储位置。 */
  readonly scratchpad?: ScratchpadPort;
  /** File 工具在当前 Turn 内共享的读取状态，用于去重和写入前校验。 */
  readonly readFileState?: ReadFileState;
  /** AskUser 工具的问询解析器。 */
  readonly askUser?: AskUserPort;
}
