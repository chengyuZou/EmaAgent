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
  bindCharacterMemoryNote,
} from './common/notes.js';
export type {
  MemoryNoteTarget,
  MemoryNoteTargetKind,
  AddMemoryNoteRequest,
  AddMemoryNote,
} from './common/notes.js';
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
export { MEMORY_SUMMARY_TOKENS } from './capacity/limits.js';
export { cleanupMemoryStorage } from './capacity/automaticCleanup.js';
export {
  listExpiredWorkHistoryFiles,
  listWorkHistoryFilesOldestFirst,
} from './work/retention.js';
export {
  listExpiredRelationshipHistoryFiles,
  listRelationshipHistoryFilesOldestFirst,
} from './relationship/lifecycle.js';
export {
  MEMORY_SETTINGS,
  memoryJobsGroup,
  memoryLifecycleGroup,
  memoryStorageMaxBytesSetting,
  memoryWorkHistoryRetentionDaysSetting,
  memoryRelationshipHistoryActiveDaysSetting,
  memoryExtractionConcurrencySetting,
  memoryHeartbeatSecondsSetting,
  memoryConsolidationCooldownHoursSetting,
} from './settings.js';
export {
  DEFAULT_MEMORY_JOBS_SETTINGS,
  DEFAULT_MEMORY_LIFECYCLE_SETTINGS,
  readMemoryJobsSettings,
  readMemoryLifecycleSettings,
} from './settings.js';
export type {
  MemoryJobsSettings,
  MemoryLifecycleSettings,
} from './settings.js';
export {
  MemoryNoteAlreadyExistsError,
  MemoryNoteCharacterRequiredError,
  MemoryNoteEmptyError,
  MemoryConsolidationError,
  MemoryStorageLimitExceededError,
  MemoryFileNotEditableError,
  MemoryFileChangedError,
} from './errors.js';
export {
  MEMORY_EXTRACTION_NO_RESULT,
  runTurnExtraction,
} from './common/extraction.js';
export type {
  CompleteExtraction,
  CompletedTurnMemoryInput,
  MemoryTurnMessage,
} from './common/extraction.js';
export {
  buildWorkExtractionInput,
  serializeWorkTurn,
} from './work/extraction.js';
export type {
  WorkExtractionInput,
} from './work/extraction.js';
export {
  buildRelationshipExtractionInput,
  serializeRelationshipTurn,
} from './relationship/extraction.js';
export type {
  RelationshipTurnMessage,
  RelationshipExtractionInput,
} from './relationship/extraction.js';
export type { MemoryEvent, MemoryEventEmitter } from './events.js';
export { JobAdmin } from './jobs/jobAdmin.js';
export type { EnqueuedExtraction } from './jobs/jobAdmin.js';
export type { MemoryJobEnqueueError } from './errors.js';
export { runExtractionJobs } from './jobs/runExtractionJobs.js';
export type {
  ExtractionRunStats,
  RunExtractionJobDeps,
} from './jobs/runExtractionJobs.js';
export { runConsolidationJobs } from './jobs/runConsolidationJobs.js';
export type {
  ConsolidateMemory,
  ConsolidationKind,
  ConsolidationRunResult,
  RunConsolidationJobDeps,
} from './jobs/runConsolidationJobs.js';
export { runMaintenanceJobs } from './jobs/runMaintenanceJobs.js';
export type {
  MaintenanceKind,
  MaintenanceRunResult,
  RunMaintenanceJobDeps,
} from './jobs/runMaintenanceJobs.js';
export { createExtractTurn } from './extractTurn.js';
export type {
  CreateExtractTurnDeps,
  ExtractTurn,
} from './extractTurn.js';
export { loadTemplate } from './templates/loader.js';
export type { ExtractionTemplates } from './templates/loader.js';
export {
  CONSOLIDATION_INPUT_INSTRUCTION,
  applyConsolidationEdits,
  listMarkdownFiles,
  parseConsolidationEdits,
  runConsolidationLlm,
  toPosixPath,
} from './consolidation/consolidation.js';
export type {
  ConsolidationEdit,
  ConsolidationPlan,
  RunConsolidationLlmInput,
} from './consolidation/consolidation.js';
export {
  createWorkConsolidate,
  createWorkTargetPathCheck,
  listWorkTargetPaths,
} from './work/consolidation.js';
export type { WorkConsolidationDeps } from './work/consolidation.js';
export {
  createRelationshipConsolidate,
  createRelationshipTargetPathCheck,
  listRelationshipTargetPaths,
} from './relationship/consolidation.js';
export type { RelationshipConsolidationDeps } from './relationship/consolidation.js';
export { buildMemoryGuidance } from './prompt.js';
export {
  searchMemoryFiles,
  readMemoryFile,
  listMemoryFiles,
  writeMemoryFile,
} from './common/memoryFiles.js';
export type {
  ListMemory,
  MemoryListEntry,
  MemoryListRequest,
  MemoryListResponse,
  MemoryReadRequest,
  MemoryReadResponse,
  MemorySearchMatch,
  MemorySearchMatchMode,
  MemorySearchRequest,
  MemorySearchResponse,
  MemoryWriteRequest,
  MemoryWriteResponse,
  ReadMemory,
  SearchMemory,
} from './common/memoryFiles.js';
