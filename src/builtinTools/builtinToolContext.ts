// Ema 内置工具的完整宿主 Context：调用身份 + 各业务能力 Port。
// 只有 builtinTools 集成层需要同时知道所有 Port；src/tools 通用框架不引用它，
// 避免 tools 反向依赖 sandbox/knowledge/tasks/agent 等业务包。
import type {
  AgentRunId,
  SessionId,
  ToolCallId,
  TurnId,
} from '@ema-agent/ids';
import type { CommandRunnerPort } from '@ema-agent/sandbox';
import type { TaskStorePort } from '@ema-agent/tasks';
import type { IArtifactStore } from '@ema-agent/artifact';
import type {
  AskUserQuestionSpec,
  FileStateStore,
  KnowledgeSearchPort,
  ReadFileState,
  SkillRunnerPort,
  SubagentSpawnerPort,
  ToolCapabilityScope,
  ToolExecutionEvent,
} from '@ema-agent/tools';

/**
 * AskUser 工具向宿主提出的问询解析器：发出结构化问询请求并等待答案。
 * 宿主在 Turn 装配时注入（绑定到该 Turn 的 per-session FIFO 回答通道）。
 */
export type AskUserPort = (
  promptId: string,
  specs: readonly AskUserQuestionSpec[],
  request: unknown,
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
 * Ema 内置工具完整宿主 Context。
 *
 * 身份和能力位于同一个对象；工具通过自己的 validateContext 投影出所需窄 Context。
 * 总字段较多没有关系——任何具体 Tool 只能拿到它 validateContext 返回的部分。
 *
 * toolCallId、单工具 signal 和 emit 由 ToolExecutionRuntime 在每次调用前覆盖；
 * 装配 Manifest 时 toolCallId 尚不存在，因此它是可选字段。
 */
export interface BuiltinToolContext {
  readonly sessionId: SessionId;
  readonly turnId: TurnId;
  /** 子 Agent 保留父 turnId，并用 agentRunId 关联实际子执行。 */
  readonly agentRunId?: AgentRunId;
  /** 执行器在单次调用前补入，权限、审计和文件写入共用该身份。 */
  readonly toolCallId?: ToolCallId;
  /** 空串表示本次执行没有工作区；文件与 Shell 工具不会进入 Manifest。 */
  readonly workspaceRoot: string;
  /** 装配时是父执行信号，调用工具时由执行器替换成单工具信号。 */
  readonly signal: AbortSignal;

  // ── 装配时绑定的执行能力 ──────────────────────────────────────────────────
  /** Bash 工具的受控命令执行器（per-session 缓存）。 */
  readonly commandRunner?: CommandRunnerPort;
  /** KB 检索工具的搜索入口。 */
  readonly knowledgeSearch?: KnowledgeSearchPort;
  /** Task 工具族的持久存储。 */
  readonly taskStore?: TaskStorePort;
  /** Subagent 工具的子 Agent 启动器。 */
  readonly subagentSpawner?: SubagentSpawnerPort;
  /** SkillCall 工具的 Skill 运行器。 */
  readonly skillRunner?: SkillRunnerPort;
  /** Artifact 工具族（V1.5 预留，默认不注册）。 */
  readonly artifactStore?: IArtifactStore;
  /** Scratchpad 工具的 Turn 级临时存储位置。 */
  readonly scratchpad?: ScratchpadPort;
  /** File 工具的跨调用去重缓存。 */
  readonly readFileState?: ReadFileState;
  /** File 工具的持久文件状态记录。 */
  readonly fileStateStore?: FileStateStore;
  /** SkillCall 收窄当前 Agent 工具能力的能力边界。 */
  readonly toolCapabilities?: ToolCapabilityScope;
  /** AskUser 工具的问询解析器。 */
  readonly askUser?: AskUserPort;

  // ── per-call 输出能力（执行器填充） ────────────────────────────────────────
  /** 发结构化事件到当前 Turn 的 SSE 流；AskUser/Task/Artifact 等用。 */
  readonly emit?: (event: ToolExecutionEvent) => void;
}

export type { AgentRunId, SessionId, TurnId };
