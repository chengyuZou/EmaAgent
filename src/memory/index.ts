// 导出 Memory 当前已经定型的文件能力.

export {
  memoryRootDir,
  workMemoryDir,
  relationshipMemoryDir,
  relationshipCharacterDir,
  workMemoryNotesDir,
  sharedRelationshipNotesDir,
  characterRelationshipNotesDir,
  turnEvidenceDir,
  memorySummaryFile,
  memoryFileSlug,
} from './common/paths.js';
export {
  memoryGitDiffFile,
  prepareMemoryGitWorkspace,
  readMemoryGitDiff,
  writeMemoryGitDiff,
  acceptMemoryGitChanges,
  removeMemoryGitDiff,
  renderMemoryGitDiff,
} from './common/gitWorkspace.js';
export {
  syncTurnEvidence,
  turnEvidenceFileName,
  renderTurnEvidence,
} from './common/turnEvidence.js';
export type { TurnEvidence } from './common/turnEvidence.js';
export {
  readMemorySummary,
  truncateMemorySummary,
} from './common/memorySummary.js';
export {
  memoryNoteFileName,
  createMemoryNote,
} from './common/notes.js';
export type { MemoryNoteTarget } from './common/notes.js';
export {
  clearAllMemory,
  clearMemoryDirectory,
  clearMemoryFiles,
} from './common/clearMemory.js';
export { measureMemoryStorageBytes } from './capacity/measureStorageBytes.js';
export {
  DEFAULT_MEMORY_STORAGE_LIMIT,
  readMemoryStorageLimit,
  evaluateMemoryStorage,
} from './capacity/storageLimit.js';
export type {
  MemoryStorageLevel,
  MemoryStorageLimit,
  MemoryStorageStatus,
} from './capacity/storageLimit.js';
export {
  DEFAULT_MEMORY_BUDGETS,
  readMemoryBudgets,
} from './capacity/budgets.js';
export type { MemoryBudgets } from './capacity/budgets.js';
export {
  MEMORY_SETTINGS,
  memoryBudgetsGroup,
  memoryStorageMaxBytesSetting,
  memorySummaryTokensSetting,
  memoryCoreFileBytesSetting,
  memoryTopicFileBytesSetting,
  memoryHistoryFileBytesSetting,
  memoryTurnEvidenceFileBytesSetting,
  memoryTurnEvidenceFilesSetting,
  memoryConsolidationItemsSetting,
  memoryConsolidationInputBytesSetting,
  memoryGitDiffBytesSetting,
} from './settings.js';
export {
  MemoryNoteAlreadyExistsError,
  MemoryNoteCharacterRequiredError,
  MemoryNoteEmptyError,
} from './errors.js';
