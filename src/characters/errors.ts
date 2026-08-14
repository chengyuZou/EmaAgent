export class CharacterPromptInvalidError extends Error {
  readonly code = 'character_prompt_invalid';

  constructor(readonly characterId?: string) {
    super(characterId
      ? `character prompt is empty: ${characterId}`
      : 'character prompt is empty');
    this.name = 'CharacterPromptInvalidError';
  }
}

export class CharacterResourcePathError extends Error {
  readonly code = 'character_resource_path_invalid';

  constructor(
    readonly relativePath: string,
    readonly reason: string,
  ) {
    super(`invalid character resource path (${reason}): ${relativePath}`);
    this.name = 'CharacterResourcePathError';
  }
}

export type CharacterResourceValidationCode =
  | 'source_file_required'
  | 'source_directory_required'
  | 'destination_directory_required'
  | 'resource_type_unsupported'
  | 'resource_too_large'
  | 'resource_directory_too_large'
  | 'resource_file_count_exceeded'
  | 'resource_name_not_portable'
  | 'case_fold_path_collision'
  | 'symbolic_link_not_allowed'
  | 'source_changed_during_copy'
  | 'export_destination_exists'
  | 'voice_format_unsupported'
  | 'voice_duration_invalid'
  | 'live2d_entry_invalid'
  | 'live2d_runtime_config_invalid'
  | 'live2d_reference_invalid'
  | 'live2d_reference_missing'
  | 'live2d_texture_invalid';

export class CharacterResourceValidationError extends Error {
  readonly code = 'character_resource_validation_failed';

  constructor(readonly reason: CharacterResourceValidationCode) {
    super(`character resource validation failed: ${reason}`);
    this.name = 'CharacterResourceValidationError';
  }
}
