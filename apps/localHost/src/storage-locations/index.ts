// 统一导出 LocalHost 使用的数据目录定位能力。

export {
  profileDir, profileDbPath, sqliteFileSet, registryPath, lockfilePath,
  dataDbPathFor, trashDirFor,
  ensureDataDirLayout,
  sessionDirFor, sessionAudioDirFor,
  removeLegacyArtifactDirectories,
  scratchpadTurnDir, removeSessionDir, removeTurnFiles,
  sweepOrphanSessionDirectories, sweepOrphanTurnFiles,
  voiceRefsDir, voiceRefsForCard, resolveVoiceRefPath, ensureProfileLayout,
  cardsDir, cardDir, cardResourcePath, resolveCardVoiceRefPath,
} from './paths.js';

export {
  loadRegistry, saveRegistry, addDir, removeDir, setActive,
  activeDirEntry,
} from './registry.js';
export type { Registry, DataDirEntry, AddDirInput } from './registry.js';

export { acquireLock } from './lockfile.js';
export type { LockInfo, LockAcquireResult } from './lockfile.js';
