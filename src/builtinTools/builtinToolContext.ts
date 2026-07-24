// Ema 内置工具的完整宿主 Context：调用身份 + 各业务能力 Port。
// 只有 builtinTools 集成层需要同时知道所有 Port；src/tools 通用框架不引用它，
// 避免 tools 反向依赖 sandbox/knowledge/tasks/agent 等业务包。
import type { AgentRunId, SessionId, TurnId } from '@ema-agent/ids';
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
  ToolInvocationContext,
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
 * 身份字段继承自 ToolInvocationContext（不含 per-call toolCallId，由执行器补充）；
 * 能力字段全部可选，工具通过自己的 validateContext 投影出所需窄 Context。
 * 总字段较多没有关系——任何具体 Tool 只能拿到它 validateContext 返回的部分。
 *
 * emit 是 per-call 输出能力（发结构化事件到 SSE 流），由 ToolExecutionRuntime
 * 在构造 per-call Context 时填充，不放入 ToolInvocationContext 的调用身份。
 */
export interface BuiltinToolContext extends Omit<ToolInvocationContext, 'toolCallId'> {
  // ── 装配时绑定的执行能力 ──────────────────────────────────────────────────
  /** Bash 工具的受控命令执行器（per-session 缓存）。 */
  commandRunner?: CommandRunnerPort;
  /** KB 检索工具的搜索入口。 */
  knowledgeSearch?: KnowledgeSearchPort;
  /** Task 工具族的持久存储。 */
  taskStore?: TaskStorePort;
  /** Subagent 工具的子 Agent 启动器。 */
  subagentSpawner?: SubagentSpawnerPort;
  /** SkillCall 工具的 Skill 运行器。 */
  skillRunner?: SkillRunnerPort;
  /** Artifact 工具族（V1.5 预留，默认不注册）。 */
  artifactStore?: IArtifactStore;
  /** Scratchpad 工具的 Turn 级临时存储位置。 */
  scratchpad?: ScratchpadPort;
  /** File 工具的跨调用去重缓存。 */
  readFileState?: ReadFileState;
  /** File 工具的持久文件状态记录。 */
  fileStateStore?: FileStateStore;
  /** SkillCall 收窄当前 Agent 工具能力的能力边界。 */
  toolCapabilities?: ToolCapabilityScope;
  /** AskUser 工具的问询解析器。 */
  askUser?: AskUserPort;

  // ── per-call 输出能力（执行器填充） ────────────────────────────────────────
  /** 发结构化事件到当前 Turn 的 SSE 流；AskUser/Task/Artifact 等用。 */
  emit?: (event: ToolExecutionEvent) => void;
}

/**
 * per-call 宿主 Context：BuiltinToolContext 补充 toolCallId、覆盖为 per-tool signal、
 * 填充 emit。ToolExecutionRuntime 在 executeOne 中构造，传给 validateContext 投影。
 */
export interface PerCallToolContext extends BuiltinToolContext {
  toolCallId: ToolInvocationContext['toolCallId'];
  signal: AbortSignal;
  emit?: (event: ToolExecutionEvent) => void;
}

export type { AgentRunId, SessionId, TurnId };
