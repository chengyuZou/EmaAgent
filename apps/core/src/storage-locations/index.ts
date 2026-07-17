// 这是 Core 路径模块的统一出口，其他代码从这里取得各类数据目录的位置。

export {
  profileDir, profileDbPath, sqliteFileSet, registryPath, lockfilePath,
  dataDbPathFor, trashDirFor,
  ensureDataDirLayout,
  sessionDirFor, sessionAudioDirFor, sessionArtifactsDirFor,
  ensureSessionLayout, scratchpadTurnDir, removeSessionDir, removeTurnFiles, sweepOrphanTurnFiles,
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
