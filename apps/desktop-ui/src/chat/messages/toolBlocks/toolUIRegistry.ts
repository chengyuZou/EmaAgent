// 复杂 Tool 的专属 UI 注册表: 按模型可见名查找, 未注册的工具回落通用平铺渲染。
// Renderer 来自各 Tool 自己目录的 UI.tsx(经 @ema-agent/tool-builtin/ui 出口);
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
} from '@ema-agent/tool-builtin/ui';

export interface ToolUIEntry {
  /** 参数区;缺省回落通用 key-value 平铺。 */
  readonly ArgsView?: (props: { args: unknown }) => JSX.Element | null;
  /** 结果区;消费类型化 data, 类型守卫失败返回 null 回落通用渲染。 */
  readonly ResultView?: (props: { data: unknown }) => JSX.Element | null;
}

const TOOL_UI_REGISTRY: Readonly<Record<string, ToolUIEntry>> = {
  Read: { ArgsView: FileReadArgsView, ResultView: FileReadResultView },
  Edit: { ArgsView: FileEditArgsView, ResultView: FileEditResultView },
  Write: { ArgsView: FileWriteArgsView, ResultView: FileWriteResultView },
  Glob: { ArgsView: GlobArgsView, ResultView: GlobResultView },
  Grep: { ArgsView: GrepArgsView, ResultView: GrepResultView },
  AskUser: { ResultView: AskUserResultView },
};

export function lookupToolUI(toolName: string): ToolUIEntry | undefined {
  return TOOL_UI_REGISTRY[toolName];
}
