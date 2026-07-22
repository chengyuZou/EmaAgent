// 这是 Artifact 包的统一出口，外部代码从这里使用它的功能。

export { ArtifactStore } from './store.js';
export { ArtifactOwnershipError } from './errors.js';
export type {
  Artifact,
  ArtifactId,
  ArtifactBase,
  ArtifactPersistence,
  ArtifactOwnership,
  ArtifactType,
  ArtifactUpdate,
  ArtifactUpsertArgs,
  IArtifactStore,
} from './types.js';
export { asArtifactId } from './types.js';
