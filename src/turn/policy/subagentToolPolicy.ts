import { BuiltinTools, type ToolPool, type ToolUseContext } from '@ema-agent/tools';

/** 子代理不直接检索长期记忆, 管理根任务或递归派发; 工具只从父 Pool 继续收窄. */
const SUBAGENT_DENIED_TOOL_IDS: ReadonlySet<string> = new Set([
  BuiltinTools.ListWindows.id,
  BuiltinTools.ObserveWindow.id,
  BuiltinTools.ComputerAction.id,
  BuiltinTools.ComputerEnd.id,
  BuiltinTools.Subagent.id,
  BuiltinTools.SubagentAwait.id,
  BuiltinTools.TaskCreate.id,
  BuiltinTools.TaskGet.id,
  BuiltinTools.TaskList.id,
  BuiltinTools.TaskUpdate.id,
  BuiltinTools.GoalGet.id,
  BuiltinTools.GoalUpdate.id,
  BuiltinTools.TodoWrite.id,
  BuiltinTools.AskUser.id,
  BuiltinTools.MemorySearch.id,
  BuiltinTools.MemoryRead.id,
  BuiltinTools.MemoryList.id,
]);


export function restrictSubagentTools(pool: ToolPool): ToolPool {
  return pool.filter(tool => !SUBAGENT_DENIED_TOOL_IDS.has(tool.id));
}

export function restrictSubagentContext(context: ToolUseContext): ToolUseContext {
  const {
    goalStore: _goalStore,
    taskStore: _taskStore,
    subagents: _subagents,
    askUser: _askUser,
    memorySearch: _memorySearch,
    memoryRead: _memoryRead,
    memoryList: _memoryList,
    computerUse: _computerUse,
    ...available
  } = context;
  return available;
}
