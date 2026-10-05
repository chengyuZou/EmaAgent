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
export { FileReadArgsView, FileReadResultView, fileReadTitle, fileReadResultCopyText } from './tools/FileReadTool/UI.js';
export {
  asFileEditResult,
  FileEditArgsView,
  FileEditResultView,
  fileEditCopyText,
  fileEditTitle,
} from './tools/FileEditTool/UI.js';
export {
  asFileWriteResult,
  FileWriteArgsView,
  FileWriteResultView,
  fileWriteTitle,
  fileWriteResultCopyText,
} from './tools/FileWriteTool/UI.js';
export { GlobArgsView, GlobResultView, globTitle, globResultCopyText } from './tools/GlobTool/UI.js';
export { GrepArgsView, GrepResultView, grepTitle, grepResultCopyText } from './tools/GrepTool/UI.js';
export { AskUserResultView, askUserResultCopyText } from './tools/AskUserTool/UI.js';
export { SkillArgsView, SkillResultView, asSkillToolResult, skillResultCopyText } from './tools/SkillTool/UI.js';
export { SubagentResultView, subagentResultCopyText } from './tools/SubagentTool/UI.js';
export {
  WebSearchArgsView,
  WebSearchProgressView,
  WebSearchResultView,
  webSearchTitle,
  webSearchResultCopyText,
} from './tools/WebSearchTool/UI.js';
export { WebFetchArgsView, WebFetchResultView, webFetchTitle, webFetchResultCopyText } from './tools/WebFetchTool/UI.js';
export {
  NarrativeSearchArgsView,
  NarrativeSearchResultView,
  narrativeSearchResultCopyText,
} from './tools/NarrativeSearchTool/UI.js';
export { PdfReadArgsView, PdfReadResultView, pdfReadResultCopyText } from './tools/PdfReadTool/UI.js';
export { TodoWriteActivitySummary, TodoWriteArgsView } from './tools/TodoWriteTool/UI.js';
export { patchToUnifiedText } from './tools/FileEditTool/patch.js';
