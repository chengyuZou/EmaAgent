import type { CommandRunner } from '@ema-agent/sandbox';
import type { ComputerUse } from '@ema-agent/computer-use';
import type { TaskStore } from '@ema-agent/tasks';
import type { GoalStore } from '@ema-agent/goal';
import type { ListMemory, ReadMemory, SearchMemory } from '@ema-agent/memory';
import type { NarrativeQueryMode, NarrativeRecallResult } from '@ema-agent/narrative';
import type { SkillPool } from '@ema-agent/skills';
import type { CallVision } from '@ema-agent/vision';
import type { FileStateCache } from '../fileState/fileStateCache.js';
import type { AskUser } from './askUser.js';
import type { SubagentControl } from './subagentControl.js';
import type { BackgroundProcess } from '../background/backgroundProcess.js';

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
  /** 主 Agent 共用的桌面操控入口, 控制归属由包内保存, 不随 Loop 或 Turn 重建. */
  readonly computerUse?: ComputerUse;
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
