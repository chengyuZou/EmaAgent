import type { SessionId } from '@ema-agent/contracts';
import type { ArtifactId } from './types.js';

export class ArtifactOwnershipError extends Error {
  readonly code = 'ownership_violation' as const;

  constructor(
    readonly artifactId: ArtifactId,
    readonly requestedSessionId: SessionId,
    readonly actualSessionId: SessionId,
  ) {
    super(`Artifact ${artifactId} belongs to session ${actualSessionId}, not ${requestedSessionId}`);
    this.name = 'ArtifactOwnershipError';
  }
}
