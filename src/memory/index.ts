// Memory 包出口(重构占位)。
// 旧架构已清空,新架构(work/chat 双轨 + common 工程层)施工中。
// 当前只暴露 common/ 纯文件层;work/chat 与对外契约(recallForTurn 注入、提取、整合)待讨论后补。
export {
  memoryRootDir,
  workRootDir,
  chatRootDir,
  characterDir,
  workNotesDir,
  characterNotesDir,
  turnEvidenceDir,
  sanitizeDirSegment,
} from './common/paths.js';
export {
  workWorkspace,
  chatWorkspace,
  renderDiffFile,
} from './common/workspace.js';
export type { TrackWorkspace } from './common/workspace.js';
export { clearMemoryRoot } from './common/control.js';
export {
  FILE_LIMITS,
  PRESSURE_ACTIONS,
  isOverBudget,
} from './common/capacity.js';
export type { PressureAction } from './common/capacity.js';
export {
  noteFilename,
  sanitizeSlug,
  workNotePath,
  characterNotePath,
} from './common/notes.js';
export {
  loadSummaryForInjection,
  truncateToTokens,
  renderMemoryGuide,
  SUMMARY_VERSION_MARKER,
} from './common/inject.js';
export type {
  SummaryInjection,
  SummaryInjectionOptions,
  LoadSummaryResult,
} from './common/inject.js';
export {
  ensureTurnEvidenceLayout,
  rebuildTurnEvidenceFiles,
  syncTurnEvidenceFiles,
  pruneTurnEvidenceFiles,
  writeTurnEvidenceFile,
  renderTurnEvidenceBody,
  retainedRows,
  turnEvidenceFileStem,
  turnEvidenceFileStemFromParts,
} from './common/storage.js';
export type { StageOutputRow } from './common/storage.js';
export {
  memoryBudgetOk,
  budgetCheck,
  snapshotAllowsStartup,
  dirSizeBytes,
  BUDGET_EXCLUDED_DIRS,
  BUDGET_SCAN_ENTRY_LIMIT,
} from './common/guard.js';
export type { BudgetSnapshot } from './common/guard.js';
export {
  parseMemoryCitation,
  parseMemoryCitationEntry,
} from './common/citations.js';
export type {
  MemoryCitation,
  MemoryCitationEntry,
} from './common/citations.js';
export {
  memoryUsageKindsFromToolCall,
  kindFromPath,
  MEMORY_TOOL_NAMES,
} from './common/usage.js';
export type {
  MemoryUsageKind,
  MemoryToolCallArgs,
} from './common/usage.js';
