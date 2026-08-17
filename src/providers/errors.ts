import type { ModelCapability } from './types.js';
import type { ModelBindingModule } from './modelBindings.js';

export type ProviderErrorCode =
  | 'already_exists'
  | 'invalid_configuration'
  | 'not_found'
  | 'capability_disabled'
  | 'credential_missing'
  | 'provider_in_use'
  | 'provider_capability_in_use'
  | 'model_not_found';

export interface ProviderBindingConflict {
  module: ModelBindingModule;
  modelId: string;
  capability: ModelCapability;
}

export class ProviderError extends Error {
  constructor(
    readonly code: ProviderErrorCode,
    message: string,
    readonly conflicts: readonly ProviderBindingConflict[] = [],
  ) {
    super(message);
    this.name = 'ProviderError';
  }
}
