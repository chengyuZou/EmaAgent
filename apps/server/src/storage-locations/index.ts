// 统一导出 Application Server 使用的数据目录定位能力。

export {
  profileDir, profileDbPath, sqliteFileSet, registryPath, lockfilePath,
  dataDbPathFor, trashDirFor,
  ensureDataDirLayout,
  sessionDirFor, sessionAudioDirFor,
  removeLegacyArtifactDirectories,
  scratchpadTurnDir, removeSessionDir, removeTurnFiles,
  sweepOrphanSessionDirectories, sweepOrphanTurnFiles,
  ensureProfileLayout,
  charactersDir, bundledCharactersDir, builtinSkillsDir, bundledSkillsDir,
} from './paths.js';

export {
  loadRegistry, saveRegistry, addDir, removeDir, setActive,
  activeDirEntry,
} from './registry.js';
export type { Registry, DataDirEntry, AddDirInput } from './registry.js';

export { acquireLock } from './lockfile.js';
export type { LockInfo, LockAcquireResult } from './lockfile.js';
