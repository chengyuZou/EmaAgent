/** subagent 从独立历史开始; fork 复制启动时的父消息, 后续写入仍各自保存. */
export type SubagentContextMode = 'subagent' | 'fork';

export interface SubagentSpawnOptions {
  /** 省略时新建, 提供时继续该稳定身份. */
  subagentId?: string;
  title?: string;
  providerId?: string;
  modelId?: string;
  /** 任务短描述(3-5 词),展示在 dashboard 与日志;映射自 SubagentTool 的 description 入参. */
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

