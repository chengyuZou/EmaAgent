// 复杂 Tool 的专属 UI 注册表: 按模型可见名查找, 未注册的工具回落通用平铺渲染。
// Renderer 来自各 Tool 自己目录的 UI.tsx(经 @ema-agent/builtin-tools/ui 出口);
// 注册表只做查找与回落, 权限卡、状态条、耗时、错误外壳仍在 ToolCallBlock。
import type { JSX } from 'react';
import {
  AskUserResultView,
  BashCallView,
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
  PowerShellCallView,
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
  WebSearchProgressView,
  WebSearchResultView,
  bashCopyText,
  bashTitle,
  fileEditCopyText,
  fileEditTitle,
  fileReadTitle,
  fileWriteTitle,
  globTitle,
  grepTitle,
  powerShellCopyText,
  powerShellTitle,
  webFetchTitle,
  webSearchTitle,
} from '@ema-agent/builtin-tools/ui';
import { BuiltinTools } from '@ema-agent/tools/identity';
import type { ToolDisplayStatus } from './toolBlockHelpers.js';

/** CallView 接管整个展开区时的入参；data 是类型化 TOutput，progress 是原始进度事件序列。 */
export interface ToolCallViewProps {
  readonly args: unknown;
  readonly partialArgs?: string;
  readonly data?: unknown;
  readonly progress?: readonly unknown[];
  readonly status: ToolDisplayStatus;
  readonly running: boolean;
  /** 打开后台进程面板；导航动作由外壳提供，Tool UI 不感知 Dock 实现。 */
  openBackgroundProcesses(): void;
}

export interface ToolUIEntry {
  /** 需要直接呈现给用户的历史卡默认展开，例如当前 Turn 的 TODO 清单。 */
  readonly defaultExpanded?: boolean;
  /** 行头摘要：Tool 自己从 args 取主目标；缺省时只显示工具名。 */
  readonly title?: (args: unknown) => string | null;
  /** 参数区（无 hooks 纯函数；返回 null = 守卫失败，回落通用平铺）。 */
  readonly ArgsView?: (props: { args: unknown }) => JSX.Element | null;
  /** 结果区（同上）；消费类型化 data。 */
  readonly ResultView?: (props: { data: unknown }) => JSX.Element | null;
  /** 运行中的进度区（同上）；没有注册的 Tool 不建立假进度。 */
  readonly ProgressView?: (props: { progress: readonly unknown[] }) => JSX.Element | null;
  /** 接管整个展开区（终端卡等组合形态）；按组件方式渲染，内部允许有状态子组件。 */
  readonly CallView?: (props: ToolCallViewProps) => JSX.Element | null;
  /** 复制文本;缺省回落 args/结果的 JSON 拼接。 */
  readonly copyText?: (args: unknown, data: unknown) => string | null;
}

const TOOL_UI_REGISTRY: Readonly<Record<string, ToolUIEntry>> = {
  [BuiltinTools.Bash.name]: {
    title: bashTitle,
    copyText: bashCopyText,
    CallView: BashCallView,
  },
  [BuiltinTools.PowerShell.name]: {
    title: powerShellTitle,
    copyText: powerShellCopyText,
    CallView: PowerShellCallView,
  },
  [BuiltinTools.FileRead.name]: {
    title: fileReadTitle,
    ArgsView: FileReadArgsView,
    ResultView: FileReadResultView,
  },
  [BuiltinTools.FileEdit.name]: {
    title: fileEditTitle,
    copyText: fileEditCopyText,
    ArgsView: FileEditArgsView,
    ResultView: FileEditResultView,
  },
  [BuiltinTools.FileWrite.name]: {
    title: fileWriteTitle,
    ArgsView: FileWriteArgsView,
    ResultView: FileWriteResultView,
  },
  [BuiltinTools.Glob.name]: { title: globTitle, ArgsView: GlobArgsView, ResultView: GlobResultView },
  [BuiltinTools.Grep.name]: { title: grepTitle, ArgsView: GrepArgsView, ResultView: GrepResultView },
  [BuiltinTools.WebFetch.name]: {
    title: webFetchTitle,
    ArgsView: WebFetchArgsView,
    ResultView: WebFetchResultView,
  },
  [BuiltinTools.WebSearch.name]: {
    title: webSearchTitle,
    ArgsView: WebSearchArgsView,
    ResultView: WebSearchResultView,
    ProgressView: WebSearchProgressView,
  },
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
