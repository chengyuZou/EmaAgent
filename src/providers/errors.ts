import type { Capability } from './types.js';
import type { ModelBindingModule } from './modelBindings.js';

export type ProviderConfigurationErrorCode =
  | 'unknown_definition'
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
  capability: Capability;
}

export class ProviderConfigurationError extends Error {
  constructor(
    readonly code: ProviderConfigurationErrorCode,
    message: string,
    readonly conflicts: readonly ProviderBindingConflict[] = [],
  ) {
    super(message);
    this.name = 'ProviderConfigurationError';
  }
}
