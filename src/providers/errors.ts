import type { Capability } from './types.js';
import type { ModelBindingModule } from './modelBindings.js';

export type ProviderConfigurationErrorCode =
  | 'unknown_definition'
  | 'invalid_capability_config'
  | 'capability_not_supported'
  | 'not_found'
  | 'provider_capability_in_use'
  | 'provider_in_use';

export interface ProviderBindingConflict {
  module: ModelBindingModule;
  model: string;
  capability?: Capability;
}

export class ProviderConfigurationError extends Error {
  constructor(
    readonly code: ProviderConfigurationErrorCode,
    message: string,
    readonly conflicts: readonly ProviderBindingConflict[] = [],
    readonly definitionId?: string,
  ) {
    super(message);
    this.name = 'ProviderConfigurationError';
  }
}
