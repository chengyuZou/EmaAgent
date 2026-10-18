import type { CommandRunner } from '@ema-agent/sandbox';
import type { TaskStore } from '@ema-agent/tasks';
import type { GoalStore } from '@ema-agent/goal';
import type { ListMemory, ReadMemory, SearchMemory } from '@ema-agent/memory';
import type { NarrativeQueryMode, NarrativeRecallResult } from '@ema-agent/narrative';
import type { SkillPool } from '@ema-agent/skills';
import type { CallVision } from '@ema-agent/vision';
import type { FileStateCache } from '../fileState/fileStateCache.js';
import type { AskUserQuestionSpec } from '../events.js';
import type { BackgroundProcess } from '../background/backgroundProcess.js';

/** subagent 从独立历史开始; fork 复制启动时的父消息, 后续写入仍各自保存. */
export type SubagentContextMode = 'subagent' | 'fork';

export interface SubagentSpawnOptions {
  /** 省略时新建, 提供时继续该稳定身份. */
  subagentId?: string;
  title?: string;
  providerId?: string;
  modelId?: string;
  /** 任务短描述(3–5 词),展示在 dashboard 与日志;映射自 SubagentTool 的 description 入参. */
  description?: string;
  contextMode?: SubagentContextMode;
}

export interface SubagentResult {
  subagentId: string;
  runId: string;
  output: string;
  usage: { inputTokens: number; outputTokens: number };
}

/**
 * 宿主把子代理控制函数绑定到当前 Session/Turn, 工具不持有进程级执行对象.
 * 接口放在 tools 中, 让 agent 与 builtin-tools 共用类型而不互相依赖.
 */
export interface SubagentControl {
  /** 启动当前 Turn 派生的子 Agent;后台形态从创建时就脱离父 Turn 取消. */
  start(
    prompt: string,
    options: SubagentSpawnOptions,
    toolCallId: string,
    runInBackground: boolean,
    signal: AbortSignal,
  ): { readonly subagentId: string; readonly runId: string };
  /** 默认 Subagent Tool 等待自己刚启动的运行. */
  waitForInitialResult(subagentId: string, signal: AbortSignal): Promise<SubagentResult | null>;
  /** 超过前台等待期限后,把同一执行转交 Session 续接. 状态不允许转交时抛错. */
  moveToBackground(subagentId: string): void;
  /**
   * 某一次 SubagentAwait Tool 调用独占等待当前 Session 的后台结果.
   * 单等待者属于 Tool 调用, 不属于 Session. 取消只终止这次等待, 不取消 Subagent.
   */
  awaitResult(subagentId: string, signal: AbortSignal): Promise<SubagentResult | null>;
  /** 取消运行中的子 Agent;未知 id 返回 false. */
  cancel(subagentId: string): boolean;
}

/**
 * AskUser 工具向宿主提出的问询解析器:发出结构化问询请求并等待答案.
 * 宿主在 Turn 装配时注入(绑定到该 Turn 的 per-session FIFO 回答通道).
 *
 * 分层有意如此:Tool 只表达"我要问,给我答案";事件发射(ask_user_required/
 * ask_user_resolved),队列排队,超时与取消清卡全是宿主职责——让 Tool 直接 emit
 * 会把 Turn 事件通道与交互队列泄进本上下文,方向反而更差.
 * 问询锚点是 toolCallId——一个交互只可能属于一次 Tool 调用,不再需要独立的 promptId.
 */
export type AskUser = (
  toolCallId: string,
  specs: readonly AskUserQuestionSpec[],
  /** 单调用级取消:Turn abort 与兄弟取消都经它中断等待;用户取消卡片走队列终态. */
  signal: AbortSignal,
) => Promise<{ answers: Record<string, string> }>;

/**
 * Scratchpad 工具所需的 Turn 级临时存储位置.
 * dir 由宿主按 Turn 隔离,author 标记写入方(主 Agent / 子 Agent).
 */
export interface Scratchpad {
  readonly dir: string;
  readonly author: string;
}

/**
 * Ema 工具宿主能力全集.
 *
 * 该对象只描述本轮宿主能提供哪些业务能力.Session,Turn,ToolCall 身份和取消
 * 信号属于 ToolInvocation;任何具体 Tool 只能取得 validateContext 返回的窄投影.
 */
export interface ToolUseContext {
  /** 空串表示本次执行没有工作区, 需要工作区的工具在 validateContext 中拒绝调用. */
  readonly cwd: string;
  /**
   * 宿主平台,装配时由 process.platform 冻结.
   * 说明书写平台差异文案(Bash 语义,路径写法,信号)只准从这里取,不得自行探测.
  */
  readonly platform: NodeJS.Platform;

  /** Bash 工具的受控命令执行器(per-session 缓存). */
  readonly commandRunner?: CommandRunner;
  /** Bash 与 Process 工具族共享的持久后台进程入口. */
  readonly backgroundProcesses?: BackgroundProcess;
  /** 当前模型绑定可用时提供的剧情查询. 身份由 ToolInvocation 管理, 结果在 Tool 中转为可保存数据. */
  readonly narrativeSearch?: (
    query: string,
    mode: NarrativeQueryMode | undefined,
    signal: AbortSignal,
  ) => Promise<NarrativeRecallResult>;
  /** Task 工具族的持久存储. */
  readonly taskStore?: TaskStore;
  /** 主 Agent 读取和报告 Session Goal, 子代理不提供此能力. */
  readonly goalStore?: GoalStore;
  /** Subagent 工具的子 Agent 启动器. */
  readonly subagents?: SubagentControl;
  /** Turn 准备时取得的技能池, 由调用方决定是否向执行环境提供. */
  readonly skillPool?: SkillPool;
  /** Scratchpad 工具的 Turn 级临时存储位置. */
  readonly scratchpad?: Scratchpad;
  /** 同一 Session 的文件正文缓存与写入前校验基准, 跨 Turn 保留. */
  readonly fileStateCache?: FileStateCache;
  /** AskUser 工具的问询解析器. */
  readonly askUser?: AskUser;
  /** 本 Turn 冻结的 vision 调用(OCR/图注);缺省时 Read 的 PDF 分支只读文本层. */
  readonly vision?: CallVision;
  /** 保存到调用它的 Session, 返回普通图片附件路径. 不经过自动捕获的空闲队列. */
  readonly captureScreen?: (sessionId: string, turnId: string, signal: AbortSignal) => Promise<string>;
  /** MemorySearch 工具的跨两轨关键词搜索能力. */
  readonly memorySearch?: SearchMemory;
  /** MemoryRead 工具的按相对路径读取正式记忆能力. */
  readonly memoryRead?: ReadMemory;
  /** MemoryList 工具的列记忆目录能力. */
  readonly memoryList?: ListMemory;
}
