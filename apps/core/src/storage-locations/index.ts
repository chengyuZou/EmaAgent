export {
  profileDir, profileDbPath, registryPath, lockfilePath,
  dataDbPathFor, audioDirFor, artifactsDirFor, trashDirFor,
  ensureDataDirLayout,
} from './paths.js';

export {
  loadRegistry, saveRegistry, addDir, removeDir, setActive,
  activeDirEntry,
} from './registry.js';
export type { Registry, DataDirEntry, AddDirInput } from './registry.js';

export { acquireLock } from './lockfile.js';
export type { LockInfo, LockAcquireResult } from './lockfile.js';
