// 内置工具的桌面 UI 出口: 仅供前端(desktop)导入, 后端入口 index.ts 不得引用本文件。
// 每个复杂 Tool 在自己的目录提供 UI.tsx, 这里统一再导出, 前端注册表按 toolId 取用。

export {
  BashCallView,
  asBashCommandResult,
  asBashProcessReference,
  bashCopyText,
  bashResultText,
  bashTitle,
} from './tools/BashTool/UI.js';
export type { BashCallStatus, BashCallViewProps } from './tools/BashTool/UI.js';
export {
  PowerShellCallView,
  powerShellCopyText,
  powerShellTitle,
} from './tools/PowerShellTool/UI.js';
export { FileReadArgsView, FileReadResultView, fileReadTitle } from './tools/FileReadTool/UI.js';
export {
  asFileEditResult,
  FileEditArgsView,
  FileEditResultView,
  fileEditCopyText,
  fileEditTitle,
  StructuredPatchCard,
} from './tools/FileEditTool/UI.js';
export {
  asFileWriteResult,
  FileWriteArgsView,
  FileWriteResultView,
  fileWriteTitle,
} from './tools/FileWriteTool/UI.js';
export { GlobArgsView, GlobResultView, globTitle } from './tools/GlobTool/UI.js';
export { GrepArgsView, GrepResultView, grepTitle } from './tools/GrepTool/UI.js';
export { AskUserResultView } from './tools/AskUserTool/UI.js';
export { SkillArgsView, SkillResultView, asSkillToolResult } from './tools/SkillTool/UI.js';
export { SubagentResultView } from './tools/SubagentTool/UI.js';
export {
  WebSearchArgsView,
  WebSearchProgressView,
  WebSearchResultView,
  webSearchTitle,
} from './tools/WebSearchTool/UI.js';
export { WebFetchArgsView, WebFetchResultView, webFetchTitle } from './tools/WebFetchTool/UI.js';
export {
  NarrativeSearchArgsView,
  NarrativeSearchResultView,
  NarrativeStatusBlock,
} from './tools/NarrativeSearchTool/UI.js';
export type { NarrativeStatusViewData } from './tools/NarrativeSearchTool/UI.js';
export { PdfReadArgsView, PdfReadResultView } from './tools/PdfReadTool/UI.js';
export { TodoWriteActivitySummary, TodoWriteArgsView } from './tools/TodoWriteTool/UI.js';
export { additionsToUnifiedText, patchToUnifiedText } from './tools/FileEditTool/patch.js';
