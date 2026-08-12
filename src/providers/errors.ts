import type { ModelCapability } from './types.js';
import type { ModelBindingModule } from './modelBindings.js';

export type ProviderConfigErrorCode =
  | 'unknown_provider'
  | 'invalid_configuration'
  | 'not_found'
  | 'capability_disabled'
  | 'credential_missing'
  | 'provider_in_use'
  | 'provider_capability_in_use'
  | 'model_not_found';

export interface ProviderBindingConflict {
  module: ModelBindingModule;
  model: string;
  capability: ModelCapability;
}

export class ProviderConfigError extends Error {
  constructor(
    readonly code: ProviderConfigErrorCode,
    message: string,
    readonly conflicts: readonly ProviderBindingConflict[] = [],
  ) {
    super(message);
    this.name = 'ProviderConfigError';
  }
}
