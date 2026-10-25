import { createElement, type JSX } from 'react';
import {
  AskUserResultView,
  askUserResultCopyText,
  BashCallView,
  CaptureResultView,
  captureTitle,
  captureResultCopyText,
  FileEditArgsView,
  FileEditResultView,
  FileReadArgsView,
  FileReadResultView,
  FileWriteArgsView,
  FileWriteResultView,
  fileWriteResultCopyText,
  fileWriteResultSummary,
  GlobArgsView,
  GlobResultView,
  globResultCopyText,
  GrepArgsView,
  GrepResultView,
  PowerShellCallView,
  SkillArgsView,
  SkillResultView,
  skillResultCopyText,
  SubagentResultView,
  subagentResultCopyText,
  NarrativeSearchResultView,
  narrativeSearchResultCopyText,
  TodoWriteArgsView,
  WebFetchArgsView,
  WebFetchResultView,
  webFetchResultCopyText,
  WebSearchArgsView,
  WebSearchProgressView,
  WebSearchResultView,
  webSearchResultCopyText,
  bashTitle,
  fileEditCopyText,
  fileEditTitle,
  fileReadTitle,
  fileReadResultCopyText,
  fileReadResultSummary,
  fileWriteTitle,
  globTitle,
  grepTitle,
  grepResultCopyText,
  powerShellTitle,
  webFetchTitle,
  webSearchTitle,
} from '@ema-agent/builtin-tools/ui';
import { BuiltinTools } from '@ema-agent/tools/identity';
import { Markdown } from '@ema-agent/ui';
import { ImagePreview } from '../../../lib/images/imagePreview.js';
import { MarkdownMedia } from '../../../lib/markdownMedia.js';
import type { ToolDisplayStatus } from './toolBlockHelpers.js';

/** CallView 接管整个展开区时收到的数据. data 是 Tool 返回的 TOutput, progress 是本次调用的进度事件. */
export interface ToolCallViewProps {
  readonly args: unknown;
  readonly partialArgs?: string;
  readonly data?: unknown;
  readonly progress?: readonly unknown[];
  readonly failure?: { readonly code: string; readonly message: string };
  readonly interrupted?: boolean;
  readonly status: ToolDisplayStatus;
  readonly running: boolean;
  /** 只读记录没有后台进程导航, 省略时 Tool UI 不显示入口. */
  openBackgroundProcesses?(): void;
}

/**
 * ArgsView, ResultView and ProgressView are conditional render callbacks.
 * Hooks belong in components returned as JSX, or opening a tool changes its parent's Hook order.
 */
export interface ToolUI {
  /** 需要直接呈现给用户的历史卡默认展开, 例如当前 Turn 的 TODO 清单. */
  readonly defaultExpanded?: boolean;
  /** Tool 从自己的 args 中提取行头主目标. 缺省时只显示工具名. */
  readonly title?: (args: unknown) => string | null;
  /** 仅控制行头文字. null 隐藏状态文字和圆点, undefined 沿用默认文案; 不改变执行状态和错误外壳. */
  readonly statusLabel?: (status: ToolDisplayStatus) => string | null | undefined;
  /** 参数区. 返回 null 表示类型守卫失败, ToolCallBlock 会回落到通用 JSON 查看器. */
  readonly ArgsView?: (props: { args: unknown }) => JSX.Element | null;
  /** 结果区. data 是 ToolResult.data 或 streaming item.output; args 供按参数高亮(如 Grep 匹配). */
  readonly ResultView?: (props: {
    data: unknown;
    args: unknown;
    /** 复制按钮之前的操作容器, null 表示输出栏尚未挂载. */
    toolbarContainer?: HTMLElement | null;
  }) => JSX.Element | null;
  /** 运行中的进度区. 没有真实 progress 结构的 Tool 不注册这个入口. */
  readonly ProgressView?: (props: { progress: readonly unknown[] }) => JSX.Element | null;
  /** 接管整个展开区, 供终端卡等需要一起处理参数, 进度和结果的 UI 使用. */
  readonly CallView?: (props: ToolCallViewProps) => JSX.Element | null;
  /** Copy only the result shown in the output pane. */
  readonly resultCopyText?: (data: unknown, args: unknown) => string | null;
  /** 与输出标题同一行显示的结果摘要, 例如 Read 的读取行数. */
  readonly resultSummary?: (data: unknown) => string | null;
}

const TOOL_UI_REGISTRY: Readonly<Record<string, ToolUI>> = {
  [BuiltinTools.Capture.name]: {
    title: captureTitle,
    resultCopyText: captureResultCopyText,
    ResultView: ({ data }) => createElement(CaptureResultView, {
      data,
      renderImage: image => createElement(ImagePreview, image),
    }),
  },
  [BuiltinTools.Bash.name]: {
    title: bashTitle,
    CallView: BashCallView,
  },
  [BuiltinTools.PowerShell.name]: {
    title: powerShellTitle,
    CallView: PowerShellCallView,
  },
  [BuiltinTools.FileRead.name]: {
    title: fileReadTitle,
    resultCopyText: fileReadResultCopyText,
    resultSummary: fileReadResultSummary,
    ArgsView: FileReadArgsView,
    ResultView: ({ data, toolbarContainer }) => createElement(FileReadResultView, {
      data,
      toolbarContainer,
      renderImage: image => createElement(ImagePreview, image),
      renderMarkdown: (source, filePath) => createElement(MarkdownMedia, {
        directory: /[\\/]/.test(filePath) ? filePath.replace(/[\\/][^\\/]+$/, '') : undefined,
        children: createElement(Markdown, { source, className: 'ema-file-read-markdown' }),
      }),
    }),
  },
  [BuiltinTools.FileEdit.name]: {
    title: fileEditTitle,
    resultCopyText: (data, args) => fileEditCopyText(args, data),
    ArgsView: FileEditArgsView,
    ResultView: FileEditResultView,
  },
  [BuiltinTools.FileWrite.name]: {
    title: fileWriteTitle,
    resultCopyText: fileWriteResultCopyText,
    resultSummary: fileWriteResultSummary,
    ArgsView: FileWriteArgsView,
    ResultView: FileWriteResultView,
  },
  [BuiltinTools.Glob.name]: { title: globTitle, resultCopyText: globResultCopyText, ArgsView: GlobArgsView, ResultView: GlobResultView },
  [BuiltinTools.Grep.name]: { title: grepTitle, resultCopyText: grepResultCopyText, ArgsView: GrepArgsView, ResultView: GrepResultView },
  [BuiltinTools.WebFetch.name]: {
    title: webFetchTitle,
    resultCopyText: webFetchResultCopyText,
    ArgsView: WebFetchArgsView,
    ResultView: WebFetchResultView,
  },
  [BuiltinTools.WebSearch.name]: {
    title: webSearchTitle,
    resultCopyText: webSearchResultCopyText,
    ArgsView: WebSearchArgsView,
    ResultView: WebSearchResultView,
    ProgressView: WebSearchProgressView,
  },
  [BuiltinTools.AskUser.name]: { resultCopyText: askUserResultCopyText, ResultView: AskUserResultView },
  [BuiltinTools.Skill.name]: { resultCopyText: skillResultCopyText, ArgsView: SkillArgsView, ResultView: SkillResultView },
  [BuiltinTools.Subagent.name]: { resultCopyText: subagentResultCopyText, ResultView: SubagentResultView },
  [BuiltinTools.NarrativeSearch.name]: {
    statusLabel: status => {
      if (status === 'success') return null;
      if (status === 'failed') return 'Error';
      return undefined;
    },
    resultCopyText: narrativeSearchResultCopyText,
    ResultView: NarrativeSearchResultView,
  },
  [BuiltinTools.TodoWrite.name]: { ArgsView: TodoWriteArgsView, defaultExpanded: true },
};

export function lookupToolUI(toolName: string): ToolUI | undefined {
  return TOOL_UI_REGISTRY[toolName];
}
