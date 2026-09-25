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

/** CallView 接管整个展开区时收到的数据. data 是 Tool 返回的 TOutput, progress 是本次调用的进度事件. */
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

export interface ToolUI {
  /** 需要直接呈现给用户的历史卡默认展开, 例如当前 Turn 的 TODO 清单. */
  readonly defaultExpanded?: boolean;
  /** Tool 从自己的 args 中提取行头主目标. 缺省时只显示工具名. */
  readonly title?: (args: unknown) => string | null;
  /** 参数区. 返回 null 表示类型守卫失败, ToolCallBlock 会回落到通用字段表. */
  readonly ArgsView?: (props: { args: unknown }) => JSX.Element | null;
  /** 结果区. data 是 ToolResult.data 或 live item.output; args 供按参数高亮(如 Grep 匹配). */
  readonly ResultView?: (props: { data: unknown; args: unknown }) => JSX.Element | null;
  /** 运行中的进度区. 没有真实 progress 结构的 Tool 不注册这个入口. */
  readonly ProgressView?: (props: { progress: readonly unknown[] }) => JSX.Element | null;
  /** 接管整个展开区, 供终端卡等需要一起处理参数, 进度和结果的 UI 使用. */
  readonly CallView?: (props: ToolCallViewProps) => JSX.Element | null;
  /** Tool 自己决定复制内容. 缺省时复制参数和结果的 JSON. */
  readonly copyText?: (args: unknown, data: unknown) => string | null;
}

const TOOL_UI_REGISTRY: Readonly<Record<string, ToolUI>> = {
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

export function lookupToolUI(toolName: string): ToolUI | undefined {
  return TOOL_UI_REGISTRY[toolName];
}
