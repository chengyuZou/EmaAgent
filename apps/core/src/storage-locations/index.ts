export {
  profileDir, profileDbPath, registryPath, lockfilePath,
  dataDbPathFor, trashDirFor,
  ensureDataDirLayout,
  sessionDirFor, sessionAudioDirFor, sessionArtifactsDirFor,
  ensureSessionLayout, removeSessionDir,
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
