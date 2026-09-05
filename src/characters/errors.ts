export class CharacterPromptInvalidError extends Error {
  readonly code = 'character_prompt_invalid';

  constructor(
    readonly reason: string,
    readonly characterName?: string,
  ) {
    super(characterName ? `${reason}: ${characterName}` : reason);
    this.name = 'CharacterPromptInvalidError';
  }
}

export class CharacterNotFoundError extends Error {
  readonly code = 'character_not_found';

  constructor(readonly characterName: string) {
    super(`character not found: ${characterName}`);
    this.name = 'CharacterNotFoundError';
  }
}

export class CharacterDirectoryConflictError extends Error {
  readonly code = 'character_directory_conflict';

  constructor(readonly characterName: string) {
    super(`character name already exists: ${characterName}`);
    this.name = 'CharacterDirectoryConflictError';
  }
}

export type CharacterInputInvalidReason =
  | 'character_patch_empty'
  | 'character_name_empty'
  | 'resource_patch_empty'
  | 'resource_name_empty'
  | 'resource_stage_scale_invalid'
  | 'resource_stage_offset_invalid'
  | 'illustration_expression_invalid'
  | 'illustration_expression_pool_full'
  | 'voice_prompt_required';

export class CharacterInputInvalidError extends Error {
  readonly code = 'character_input_invalid';

  constructor(
    readonly reason: CharacterInputInvalidReason,
    readonly characterName?: string,
  ) {
    super(characterInputInvalidMessage(reason));
    this.name = 'CharacterInputInvalidError';
  }
}

export type CharacterResourceKind = 'live2d_model' | 'illustration' | 'voice_sample';

export class CharacterResourceNotFoundError extends Error {
  readonly code = 'character_resource_not_found';

  constructor(
    readonly resourceKind: CharacterResourceKind,
    readonly resourceName: string,
  ) {
    super(`${resourceKind} resource not found: ${resourceName}`);
    this.name = 'CharacterResourceNotFoundError';
  }
}

export type CharacterStateInvalidReason =
  | 'active_character_missing';

export class CharacterStateInvalidError extends Error {
  readonly code = 'character_state_invalid';

  constructor(
    readonly reason: CharacterStateInvalidReason,
    readonly characterName?: string,
  ) {
    super('no active character - call ensureSeed() at startup');
    this.name = 'CharacterStateInvalidError';
  }
}

export class CharacterResourcePathError extends Error {
  readonly code = 'character_resource_path_invalid';

  constructor(
    readonly value: string,
    readonly reason: string,
  ) {
    super(`invalid character resource name (${reason}): ${value}`);
    this.name = 'CharacterResourcePathError';
  }
}

export type CharacterResourceValidationCode =
  | 'source_file_required'
  | 'source_directory_required'
  | 'destination_directory_required'
  | 'resource_type_unsupported'
  | 'resource_too_large'
  | 'invalid_resource_values'
  | 'zip_entry_path_invalid'
  | 'zip_invalid'
  | 'resource_name_conflict'
  | 'export_destination_exists'
  | 'voice_format_unsupported'
  | 'voice_duration_invalid'
  | 'live2d_entry_invalid'
  | 'live2d_reference_invalid'
  | 'live2d_runtime_config_invalid'
  | 'live2d_mapping_target_invalid'
  | 'illustration_format_unsupported';

export class CharacterResourceValidationError extends Error {
  readonly code = 'character_resource_validation_failed';

  constructor(readonly reason: CharacterResourceValidationCode) {
    super(`character resource validation failed: ${reason}`);
    this.name = 'CharacterResourceValidationError';
  }
}

function characterInputInvalidMessage(reason: CharacterInputInvalidReason): string {
  switch (reason) {
    case 'character_patch_empty': return 'character patch is empty';
    case 'character_name_empty': return 'character name is empty';
    case 'resource_patch_empty': return 'character resource patch is empty';
    case 'resource_name_empty': return 'character resource name is empty';
    case 'resource_stage_scale_invalid': return 'character resource stage scale is invalid';
    case 'resource_stage_offset_invalid': return 'character resource stage offset is invalid';
    case 'illustration_expression_invalid': return 'illustration expression is invalid';
    case 'illustration_expression_pool_full': return 'illustration expression pool is full';
    case 'voice_prompt_required': return 'voice prompt text and language are required';
  }
}
