// 内置工具的桌面 UI 出口: 仅供前端(desktop)导入, 后端入口 index.ts 不得引用本文件。
// 每个复杂 Tool 在自己的目录提供 UI.tsx, 这里统一再导出, 前端注册表按 toolId 取用。

export { FileReadArgsView, FileReadResultView } from './tools/FileReadTool/UI.js';
export {
  asFileEditResult,
  FileEditArgsView,
  FileEditResultView,
  StructuredPatchCard,
} from './tools/FileEditTool/UI.js';
export {
  asFileWriteResult,
  FileWriteArgsView,
  FileWriteResultView,
} from './tools/FileWriteTool/UI.js';
export { GlobArgsView, GlobResultView } from './tools/GlobTool/UI.js';
export { GrepArgsView, GrepResultView } from './tools/GrepTool/UI.js';
export { AskUserResultView } from './tools/AskUserTool/UI.js';
export { SkillArgsView, SkillResultView, asSkillToolResult } from './tools/SkillTool/UI.js';
export { SubagentResultView } from './tools/SubagentTool/UI.js';
export { WebSearchArgsView, WebSearchResultView } from './tools/WebSearchTool/UI.js';
export { WebFetchArgsView, WebFetchResultView } from './tools/WebFetchTool/UI.js';
export {
  NarrativeSearchArgsView,
  NarrativeSearchResultView,
  NarrativeStatusBlock,
} from './tools/NarrativeSearchTool/UI.js';
export { PdfReadArgsView, PdfReadResultView } from './tools/PdfReadTool/UI.js';
export { additionsToUnifiedText, patchToUnifiedText } from './tools/FileEditTool/patch.js';
