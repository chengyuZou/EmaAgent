export class CharacterPromptInvalidError extends Error {
  readonly code = 'character_prompt_invalid';

  constructor(
    readonly reason: string,
    readonly characterId?: string,
    readonly blockId?: string,
  ) {
    super(characterId ? `${reason}: ${characterId}` : reason);
    this.name = 'CharacterPromptInvalidError';
  }
}

export class CharacterNotFoundError extends Error {
  readonly code = 'character_not_found';

  constructor(readonly characterId: string) {
    super(`character not found: ${characterId}`);
    this.name = 'CharacterNotFoundError';
  }
}

export class CharacterReadOnlyError extends Error {
  readonly code = 'character_read_only';

  constructor(readonly characterId: string) {
    super(`builtin character is read-only: ${characterId}`);
    this.name = 'CharacterReadOnlyError';
  }
}

export class CharacterActiveDeleteError extends Error {
  readonly code = 'character_active_delete_forbidden';

  constructor(readonly characterId: string) {
    super(`active character cannot be deleted: ${characterId}`);
    this.name = 'CharacterActiveDeleteError';
  }
}

export class CharacterDirectoryConflictError extends Error {
  readonly code = 'character_directory_conflict';

  constructor(readonly directoryName: string) {
    super(`character directory already exists: ${directoryName}`);
    this.name = 'CharacterDirectoryConflictError';
  }
}

export type CharacterInputInvalidReason =
  | 'character_patch_empty'
  | 'character_name_empty'
  | 'prompt_block_patch_empty'
  | 'resource_patch_empty'
  | 'resource_name_empty'
  | 'resource_stage_scale_invalid'
  | 'resource_stage_offset_invalid';

export class CharacterInputInvalidError extends Error {
  readonly code = 'character_input_invalid';

  constructor(
    readonly reason: CharacterInputInvalidReason,
    readonly characterId?: string,
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
    readonly resourceId: string,
  ) {
    super(`${resourceKind} resource not found: ${resourceId}`);
    this.name = 'CharacterResourceNotFoundError';
  }
}

export class CharacterResourceMissingError extends Error {
  readonly code = 'character_resource_missing';

  constructor(
    readonly resourceKind: CharacterResourceKind,
    readonly resourcePath: string,
  ) {
    super(`${resourceKind} resource is missing: ${resourcePath}`);
    this.name = 'CharacterResourceMissingError';
  }
}

export type CharacterStateInvalidReason =
  | 'active_character_missing'
  | 'builtin_resource_id_missing';

export class CharacterStateInvalidError extends Error {
  readonly code = 'character_state_invalid';

  constructor(
    readonly reason: CharacterStateInvalidReason,
    readonly characterId?: string,
    readonly resourceKind?: CharacterResourceKind,
  ) {
    const message = reason === 'active_character_missing'
      ? 'no active character - call ensureSeed() at startup'
      : `builtin ${resourceKind ?? 'unknown'} resource requires id: ${characterId ?? 'unknown'}`;
    super(message);
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
  | 'source_zip_required'
  | 'destination_directory_required'
  | 'resource_type_unsupported'
  | 'resource_too_large'
  | 'zip_entry_count_exceeded'
  | 'zip_expanded_size_exceeded'
  | 'zip_entry_path_invalid'
  | 'zip_invalid'
  | 'resource_name_conflict'
  | 'export_destination_exists'
  | 'voice_format_unsupported'
  | 'voice_duration_invalid'
  | 'live2d_entry_invalid'
  | 'live2d_runtime_config_invalid'
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
    case 'prompt_block_patch_empty': return 'Prompt Block patch is empty';
    case 'resource_patch_empty': return 'character resource patch is empty';
    case 'resource_name_empty': return 'character resource name is empty';
    case 'resource_stage_scale_invalid': return 'character resource stage scale is invalid';
    case 'resource_stage_offset_invalid': return 'character resource stage offset is invalid';
  }
}
