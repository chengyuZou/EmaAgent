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
export {
  MemoryNoteAlreadyExistsError,
  MemoryNoteCharacterRequiredError,
  MemoryNoteEmptyError,
} from './errors.js';
