// 复杂 Tool 的专属 UI 注册表: 按模型可见名查找, 未注册的工具回落通用平铺渲染。
// Renderer 来自各 Tool 自己目录的 UI.tsx(经 @ema-agent/builtin-tools/ui 出口);
// 注册表只做查找与回落, 权限卡、状态条、耗时、错误外壳仍在 ToolCallBlock。
import type { JSX } from 'react';
import {
  AskUserResultView,
  FileEditArgsView,
  FileEditResultView,
  FileReadArgsView,
  FileReadResultView,
  FileWriteArgsView,
  FileWriteResultView,
  GlobArgsView,
  GlobResultView,
  GrepArgsView,
  GrepResultView,
  SkillArgsView,
  SkillResultView,
  SubagentResultView,
  NarrativeSearchArgsView,
  NarrativeSearchResultView,
  PdfReadArgsView,
  PdfReadResultView,
  TodoWriteArgsView,
  WebFetchArgsView,
  WebFetchResultView,
  WebSearchArgsView,
  WebSearchResultView,
} from '@ema-agent/builtin-tools/ui';
import { BuiltinTools } from '@ema-agent/tools';

export interface ToolUIEntry {
  /** 需要直接呈现给用户的历史卡默认展开，例如当前 Turn 的 TODO 清单。 */
  readonly defaultExpanded?: boolean;
  /** 参数区;缺省回落通用 key-value 平铺。 */
  readonly ArgsView?: (props: { args: unknown }) => JSX.Element | null;
  /** 结果区;消费类型化 data, 类型守卫失败返回 null 回落通用渲染。 */
  readonly ResultView?: (props: { data: unknown }) => JSX.Element | null;
}

const TOOL_UI_REGISTRY: Readonly<Record<string, ToolUIEntry>> = {
  [BuiltinTools.FileRead.name]: { ArgsView: FileReadArgsView, ResultView: FileReadResultView },
  [BuiltinTools.FileEdit.name]: { ArgsView: FileEditArgsView, ResultView: FileEditResultView },
  [BuiltinTools.FileWrite.name]: { ArgsView: FileWriteArgsView, ResultView: FileWriteResultView },
  [BuiltinTools.Glob.name]: { ArgsView: GlobArgsView, ResultView: GlobResultView },
  [BuiltinTools.Grep.name]: { ArgsView: GrepArgsView, ResultView: GrepResultView },
  [BuiltinTools.WebFetch.name]: { ArgsView: WebFetchArgsView, ResultView: WebFetchResultView },
  [BuiltinTools.WebSearch.name]: { ArgsView: WebSearchArgsView, ResultView: WebSearchResultView },
  [BuiltinTools.AskUser.name]: { ResultView: AskUserResultView },
  [BuiltinTools.Skill.name]: { ArgsView: SkillArgsView, ResultView: SkillResultView },
  [BuiltinTools.Subagent.name]: { ResultView: SubagentResultView },
  [BuiltinTools.NarrativeSearch.name]: {
    ArgsView: NarrativeSearchArgsView,
    ResultView: NarrativeSearchResultView,
  },
  [BuiltinTools.PdfRead.name]: { ArgsView: PdfReadArgsView, ResultView: PdfReadResultView },
  [BuiltinTools.TodoWrite.name]: { ArgsView: TodoWriteArgsView, defaultExpanded: true },
};

export function lookupToolUI(toolName: string): ToolUIEntry | undefined {
  return TOOL_UI_REGISTRY[toolName];
}
