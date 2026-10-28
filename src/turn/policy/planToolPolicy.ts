import { BuiltinTools, type ToolPool } from '@ema-agent/tools';

// Plan 按整项能力筛选, 不执行尚未生成参数的工具来推测是否只读.
const PLAN_TOOL_IDS: ReadonlySet<string> = new Set([
  BuiltinTools.FileRead.id,
  BuiltinTools.DescribeImage.id,
  BuiltinTools.Capture.id,
  BuiltinTools.Glob.id,
  BuiltinTools.Grep.id,
  BuiltinTools.WebFetch.id,
  BuiltinTools.WebSearch.id,
  BuiltinTools.ProcessList.id,
  BuiltinTools.ProcessOutput.id,
  BuiltinTools.TaskGet.id,
  BuiltinTools.TaskList.id,
  BuiltinTools.NarrativeSearch.id,
  BuiltinTools.MemorySearch.id,
  BuiltinTools.MemoryRead.id,
  BuiltinTools.MemoryList.id,
  BuiltinTools.Skill.id,
  BuiltinTools.ScratchpadRead.id,
  BuiltinTools.ScratchpadList.id,
]);


export function restrictPlanTools(pool: ToolPool): ToolPool {
  return pool.filter(tool => PLAN_TOOL_IDS.has(tool.id));
}
